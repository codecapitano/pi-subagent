export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;
export const CONCURRENCY_ENV = "PI_SUBAGENT_MAX_CONCURRENCY";

/** Child limit from the environment: unset or non-numeric gives the default; numbers clamp to 1..16. */
export function parseConcurrency(env) {
	const raw = env?.[CONCURRENCY_ENV];
	const value = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(value) ? Math.min(MAX_CONCURRENCY, Math.max(1, value)) : DEFAULT_CONCURRENCY;
}
export const KILL_GRACE_MS = 5000;

/**
 * Runs child processes behind a shared FIFO slot limiter.
 *
 * A slot is acquired before `prepare()`/spawn and released exactly once, only after the
 * child has closed (or was never started). Aborts never spawn queued work; running
 * children get SIGTERM, then SIGKILL after `killGraceMs`, and keep their slot until close.
 * A prepared command with `detached: true` leads its own process group and the signals go
 * to the whole group, so grandchildren cannot outlive a cancelled child.
 * Optional `timeoutMs` starts after spawn and uses the same termination path.
 * Timeouts return "failed" with `timedOut: true`; cancellation returns "aborted".
 *
 * `run()` never rejects. Its result is `{ status, exitCode, signal, error, spawned }`
 * where status is "completed" | "failed" | "aborted".
 */
export function createChildRunner({
	capacity = DEFAULT_CONCURRENCY,
	spawn,
	kill = process.kill.bind(process),
	setTimeout: setTimer = globalThis.setTimeout,
	clearTimeout: clearTimer = globalThis.clearTimeout,
	killGraceMs = KILL_GRACE_MS,
}) {
	let active = 0;
	let closed = false;
	let shutdownPromise;
	const queue = [];
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
		while (queue.length > 0 && active < capacity) {
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
		if (active < capacity && queue.length === 0) {
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
		const { signal, prepare, cleanup, onState, onStdout, onStderr, timeoutMs } = spec;
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
					stdio: ["ignore", "pipe", "pipe"],
					detached: command.detached === true,
					env: command.env,
				});
			} catch (error) {
				return failed(error);
			}
			emit("running");

			return await new Promise((resolve) => {
				let settled = false;
				let terminating = false;
				let timer = null;
				let timeoutTimer = null;
				let timedOut = false;
				let spawnError;

				const detached = command.detached === true;
				const safeKill = (sig) => {
					try {
						if (detached && proc.pid !== undefined) kill(-proc.pid, sig);
						else proc.kill(sig);
						return;
					} catch {
						/* group or process may already be gone */
					}
					if (!detached) return;
					try {
						proc.kill(sig);
					} catch {
						/* already gone */
					}
				};
				const terminate = () => {
					if (terminating || settled) return;
					terminating = true;
					safeKill("SIGTERM");
					timer = setTimer(() => {
						timer = null;
						// A detached group may outlive its leader while holding the pipes open.
						if (!settled && (detached || (proc.exitCode === null && proc.signalCode === null))) safeKill("SIGKILL");
					}, killGraceMs);
				};
				const finish = (code, sig) => {
					if (settled) return;
					settled = true;
					if (timer !== null) clearTimer(timer);
					timer = null;
					if (timeoutTimer !== null) clearTimer(timeoutTimer);
					timeoutTimer = null;
					const base = { exitCode: code ?? 1, signal: sig ?? null, spawned: true };
					if (abortRequested) resolve({ ...base, status: "aborted" });
					else if (timedOut) resolve({ ...base, status: "failed", timedOut: true, error: `Subagent timed out after ${timeoutMs} ms` });
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
				// Queue time is excluded. Termination keeps the slot until close, just like cancellation.
				if (timeoutMs !== undefined && !terminating && !settled) {
					timeoutTimer = setTimer(() => {
						timeoutTimer = null;
						if (terminating || settled) return;
						timedOut = true;
						terminate();
					}, timeoutMs);
				}
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
