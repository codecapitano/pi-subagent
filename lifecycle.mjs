export const DEFAULT_CONCURRENCY = 6;
export const DEFAULT_CEILING = 8;
export const MAX_CONCURRENCY = 16;
export const CONCURRENCY_ENV = "PI_SUBAGENT_MAX_CONCURRENCY";
export const CEILING_ENV = "PI_SUBAGENT_CONCURRENCY_CEILING";

function parseLimit(env, name) {
	const raw = env?.[name];
	if (raw === undefined || raw === "") return undefined;
	if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_CONCURRENCY) {
		throw new Error(`Invalid ${name}=${JSON.stringify(raw)}: expected an integer from 1 to ${MAX_CONCURRENCY}.`);
	}
	return Number(raw);
}

/**
 * Returns the base child limit and the ceiling a single call may raise it to.
 * Throws a clear error for invalid settings. An unset ceiling never sits below the base.
 */
export function parseConcurrency(env) {
	const base = parseLimit(env, CONCURRENCY_ENV) ?? DEFAULT_CONCURRENCY;
	const ceiling = parseLimit(env, CEILING_ENV) ?? Math.max(base, DEFAULT_CEILING);
	if (ceiling < base) {
		throw new Error(`Invalid ${CEILING_ENV}=${ceiling}: must not be below ${CONCURRENCY_ENV}=${base}.`);
	}
	return { base, ceiling };
}
export const KILL_GRACE_MS = 5000;

/**
 * Runs child processes behind a shared FIFO slot limiter.
 *
 * A slot is acquired before `prepare()`/spawn and released exactly once, only after the
 * child has closed (or was never started). Aborts never spawn queued work; running
 * children get SIGTERM, then SIGKILL after `killGraceMs`, and keep their slot until close.
 *
 * `prepare()` may also return `stdin: true` (pipe stdin instead of ignoring it) and `env` (merged over
 * the parent's environment). `onSpawn(proc)` then lets the caller write to the child.
 *
 * `run()` never rejects. Its result is `{ status, exitCode, signal, error, spawned }`
 * where status is "completed" | "failed" | "aborted".
 */
export function createChildRunner({
	capacity = DEFAULT_CONCURRENCY,
	ceiling = capacity,
	spawn,
	setTimeout: setTimer = globalThis.setTimeout,
	clearTimeout: clearTimer = globalThis.clearTimeout,
	killGraceMs = KILL_GRACE_MS,
}) {
	let active = 0;
	let closed = false;
	let shutdownPromise;
	const queue = [];
	// Per-call raises above `capacity`, each bounded by `ceiling` and removed when its call ends.
	// Objects, not numbers, so two raises to the same value release independently.
	const raises = new Set();
	const effective = () => Math.max(capacity, ...[...raises].map((r) => r.value));
	const entries = new Set();
	const tracked = new Set();
	const abortGroups = new Map();
	// A large batch shares its signal. One listener avoids EventTarget warnings and
	// lets overlapping calls with the same signal retain independent cleanup.
	const listenForAbort = (signal, entry) => {
		if (!signal) return () => {};
		let group = abortGroups.get(signal);
		if (!group) {
			group = { entries: new Set(), onAbort: null };
			group.onAbort = () => { for (const item of [...group.entries]) item.abort(); };
			abortGroups.set(signal, group);
			signal.addEventListener("abort", group.onAbort, { once: true });
		}
		group.entries.add(entry);
		return () => {
			group.entries.delete(entry);
			if (group.entries.size === 0) {
				signal.removeEventListener("abort", group.onAbort);
				abortGroups.delete(signal);
			}
		};
	};

	const drain = () => {
		while (queue.length > 0 && active < effective()) {
			const waiter = queue.shift();
			active++;
			waiter.grant(makeRelease());
		}
	};
	const makeRelease = () => {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			active--;
			drain();
		};
	};
	// Resolves to a release function, or null when `entry` was aborted while queued.
	const acquire = (entry) => {
		if (active < effective() && queue.length === 0) {
			active++;
			return Promise.resolve(makeRelease());
		}
		return new Promise((resolve) => {
			const waiter = { grant: resolve };
			queue.push(waiter);
			entry.abortHook = () => {
				const index = queue.indexOf(waiter);
				if (index === -1) return;
				queue.splice(index, 1);
				resolve(null);
			};
		});
	};

	async function execute(spec) {
		const { signal, prepare, cleanup, onState, onStdout, onStderr, onSpawn } = spec;
		const emit = (state) => {
			try {
				onState?.(state);
			} catch {
				/* observers must not break scheduling */
			}
		};
		const aborted = (spawned = false) => ({ status: "aborted", exitCode: null, signal: null, spawned });
		const failed = (error, spawned = false) => ({
			status: "failed",
			exitCode: 1,
			signal: null,
			error: error instanceof Error ? error.message : String(error),
			spawned,
		});

		if (closed || signal?.aborted) return aborted();

		let abortRequested = false;
		const entry = {
			abortHook: null,
			abort() {
				abortRequested = true;
				entry.abortHook?.();
			},
		};
		entries.add(entry);
		const stopListening = listenForAbort(signal, entry);

		let release = null;
		let prepared = false;
		try {
			emit("queued");
			release = await acquire(entry);
			entry.abortHook = null;
			if (!release || abortRequested) return aborted();

			let command;
			try {
				prepared = true;
				command = await prepare();
			} catch (error) {
				return failed(error);
			}
			// Re-check after acquisition and preparation: never spawn aborted work.
			if (abortRequested) return aborted();

			let proc;
			try {
				proc = spawn(command.command, command.args, {
					cwd: command.cwd,
					shell: false,
					stdio: [command.stdin ? "pipe" : "ignore", "pipe", "pipe"],
					...(command.env ? { env: { ...process.env, ...command.env } } : {}),
				});
			} catch (error) {
				return failed(error);
			}
			// A child that exits early closes its stdin; the resulting EPIPE must not crash the parent.
			proc.stdin?.on("error", () => {});
			emit("running");
			try {
				onSpawn?.(proc);
			} catch {
				/* observers must not break scheduling */
			}

			return await new Promise((resolve) => {
				let settled = false;
				let terminating = false;
				let timer = null;
				let spawnError;

				const safeKill = (sig) => {
					try {
						proc.kill(sig);
					} catch {
						/* process may already be gone */
					}
				};
				const terminate = () => {
					if (terminating || settled) return;
					terminating = true;
					safeKill("SIGTERM");
					timer = setTimer(() => {
						timer = null;
						if (!settled && proc.exitCode === null && proc.signalCode === null) safeKill("SIGKILL");
					}, killGraceMs);
				};
				const finish = (code, sig) => {
					if (settled) return;
					settled = true;
					if (timer !== null) clearTimer(timer);
					timer = null;
					const base = { exitCode: code ?? 1, signal: sig ?? null, spawned: true };
					if (abortRequested) resolve({ ...base, status: "aborted" });
					else if (spawnError || sig || code !== 0) {
						resolve({ ...base, status: "failed", error: spawnError ? spawnError.message : undefined });
					} else resolve({ ...base, status: "completed" });
				};

				const outputError = (error) => {
					spawnError ??= error instanceof Error ? error : new Error(String(error));
					terminate();
				};
				const receive = (callback, chunk) => {
					if (settled || spawnError) return;
					try {
						callback?.(chunk);
					} catch (error) {
						outputError(error);
					}
				};
				proc.stdout?.on("data", (chunk) => receive(onStdout, chunk));
				proc.stderr?.on("data", (chunk) => receive(onStderr, chunk));
				proc.stdout?.on("error", outputError);
				proc.stderr?.on("error", outputError);
				proc.on("close", (code, sig) => finish(code, sig));
				proc.on("error", (error) => {
					spawnError ??= error;
					// A child that never started will not emit close.
					if (proc.pid === undefined) finish(null, null);
				});
				entry.abortHook = terminate;
				if (abortRequested) terminate();
			});
		} finally {
			stopListening();
			entries.delete(entry);
			if (prepared) {
				try {
					await cleanup?.();
				} catch {
					/* best effort */
				}
			}
			release?.();
		}
	}

	return {
		run(spec) {
			const promise = execute(spec);
			tracked.add(promise);
			promise.then(
				() => tracked.delete(promise),
				() => tracked.delete(promise),
			);
			return promise;
		},
		stats: () => ({ active, queued: queue.length }),
		/**
		 * Raises the active limit to `limit` (clamped to the ceiling) until the returned
		 * function is called. Never lowers it: running children keep their slots and other
		 * overlapping calls are unaffected. The release function is idempotent.
		 */
		raise(limit) {
			const value = Math.min(ceiling, Math.floor(limit));
			if (!(value > capacity)) return () => {};
			const raise = { value };
			raises.add(raise);
			drain();
			return () => {
				raises.delete(raise);
			};
		},
		/** Aborts queued and running work; resolves after every child has terminated. */
		shutdown() {
			if (!shutdownPromise) {
				closed = true;
				for (const entry of [...entries]) entry.abort();
				shutdownPromise = Promise.allSettled([...tracked]).then(() => undefined);
			}
			return shutdownPromise;
		},
	};
}
