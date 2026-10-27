import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConcurrency } from "./lifecycle.mjs";

test("concurrency defaults to 4 when unset, empty or not a number", () => {
	for (const value of [undefined, "", " ", "abc"]) {
		assert.equal(parseConcurrency({ PI_SUBAGENT_MAX_CONCURRENCY: value }), 4, `value ${JSON.stringify(value)}`);
	}
	assert.equal(parseConcurrency({}), 4);
});

test("concurrency is clamped to 1 through 16", () => {
	const limit = (value) => parseConcurrency({ PI_SUBAGENT_MAX_CONCURRENCY: value });
	assert.deepEqual(["0", "-3", "1", "7", "16", "17", "99", "2.9"].map(limit), [1, 1, 1, 7, 16, 16, 16, 2]);
});

// ---------------------------------------------------------------------------
// Child runner (process boundary faked)
// ---------------------------------------------------------------------------
import { EventEmitter } from "node:events";
import { createChildRunner } from "./lifecycle.mjs";

class FakeProc extends EventEmitter {
	constructor(pid) {
		super();
		this.pid = pid;
		this.stdout = new EventEmitter();
		this.stderr = new EventEmitter();
		this.exitCode = null;
		this.signalCode = null;
		this.kills = [];
	}
	kill(sig) {
		this.kills.push(sig);
		if (this.killThrows) throw new Error("kill failed");
		return true;
	}
	exit(code, sig = null) {
		this.exitCode = sig ? null : code;
		this.signalCode = sig;
		this.emit("close", sig ? null : code, sig);
	}
}

function world(capacity = 4, kill = undefined) {
	const w = {
		procs: [],
		spawnCalls: [],
		timers: [],
		spawnError: undefined,
		spawn(command, args, options) {
			w.spawnCalls.push({ command, args, options });
			if (w.spawnError) throw w.spawnError;
			const p = new FakeProc(1000 + w.procs.length);
			w.procs.push(p);
			return p;
		},
		setTimeout(fn, ms) {
			const t = { fn, ms, cleared: false };
			w.timers.push(t);
			return t;
		},
		clearTimeout(t) {
			t.cleared = true;
		},
	};
	w.runner = createChildRunner({
		capacity,
		kill,
		spawn: w.spawn,
		setTimeout: w.setTimeout,
		clearTimeout: w.clearTimeout,
	});
	return w;
}

const tick = () => new Promise((r) => setImmediate(r));
const spec = (name, extra = {}) => ({
	prepare: () => ({ command: "pi", args: [name], cwd: `/cwd/${name}` }),
	...extra,
});

test("run spawns prepared command with cwd and reports completed after close", async () => {
	const w = world();
	const out = [];
	const states = [];
	const p = w.runner.run(spec("a", { onStdout: (c) => out.push(c.toString()), onState: (s) => states.push(s) }));
	await tick();
	assert.equal(w.spawnCalls.length, 1);
	assert.equal(w.spawnCalls[0].command, "pi");
	assert.deepEqual(w.spawnCalls[0].args, ["a"]);
	assert.equal(w.spawnCalls[0].options.cwd, "/cwd/a");
	assert.equal(w.spawnCalls[0].options.shell, false);
	assert.deepEqual(w.spawnCalls[0].options.stdio, ["ignore", "pipe", "pipe"]);
	w.procs[0].stdout.emit("data", Buffer.from("hi"));
	w.procs[0].exit(0);
	const r = await p;
	assert.equal(r.status, "completed");
	assert.equal(r.exitCode, 0);
	assert.deepEqual(out, ["hi"]);
	assert.deepEqual(states, ["queued", "running"]);
	assert.deepEqual(w.runner.stats(), { active: 0, queued: 0 });
});

test("non-zero exit is failed and keeps the exit code", async () => {
	const w = world();
	const p = w.runner.run(spec("a"));
	await tick();
	w.procs[0].exit(3);
	const r = await p;
	assert.equal(r.status, "failed");
	assert.equal(r.exitCode, 3);
});

test("capacity limits active children and queued runs start FIFO", async () => {
	const w = world(2);
	const started = [];
	const ps = ["a", "b", "c", "d"].map((n) => w.runner.run(spec(n, { onState: (s) => s === "running" && started.push(n) })));
	await tick();
	assert.deepEqual(started, ["a", "b"]);
	assert.deepEqual(w.runner.stats(), { active: 2, queued: 2 });
	w.procs[1].exit(0); // b finishes first
	await tick();
	assert.deepEqual(started, ["a", "b", "c"]);
	w.procs[0].exit(0);
	await tick();
	assert.deepEqual(started, ["a", "b", "c", "d"]);
	w.procs[2].exit(0);
	w.procs[3].exit(0);
	await Promise.all(ps);
	assert.deepEqual(w.runner.stats(), { active: 0, queued: 0 });
});

test("prepare failure is reported as failed without spawning and frees the slot", async () => {
	const w = world(1);
	const cleaned = [];
	const bad = w.runner.run({
		prepare: () => {
			throw new Error("no prompt file");
		},
		cleanup: () => cleaned.push("bad"),
	});
	const good = w.runner.run(spec("g"));
	const r = await bad;
	assert.equal(r.status, "failed");
	assert.match(r.error, /no prompt file/);
	assert.deepEqual(cleaned, ["bad"]);
	await tick();
	assert.equal(w.spawnCalls.length, 1);
	w.procs[0].exit(0);
	assert.equal((await good).status, "completed");
});

test("spawn throwing is failed, cleans up and frees the slot", async () => {
	const w = world(1);
	w.spawnError = new Error("EAGAIN");
	const cleaned = [];
	const r1 = await w.runner.run(spec("a", { cleanup: () => cleaned.push("a") }));
	assert.equal(r1.status, "failed");
	assert.match(r1.error, /EAGAIN/);
	assert.deepEqual(cleaned, ["a"]);
	assert.deepEqual(w.runner.stats(), { active: 0, queued: 0 });
	w.spawnError = undefined;
	const p = w.runner.run(spec("b"));
	await tick();
	w.procs[0].exit(0);
	assert.equal((await p).status, "completed");
});

test("signal exit is a failure with a non-zero exit code", async () => {
	const w = world();
	const p = w.runner.run(spec("a"));
	await tick();
	w.procs[0].exit(null, "SIGSEGV");
	const r = await p;
	assert.equal(r.status, "failed");
	assert.equal(r.signal, "SIGSEGV");
	assert.notEqual(r.exitCode, 0);
});

test("error followed by close settles once as failed and releases the slot once", async () => {
	const w = world(1);
	const p1 = w.runner.run(spec("a"));
	const p2 = w.runner.run(spec("b"));
	const p3 = w.runner.run(spec("c"));
	await tick();
	w.procs[0].emit("error", new Error("boom"));
	await tick();
	assert.equal(w.procs.length, 1, "slot is held until the child closes");
	w.procs[0].exit(0);
	const r = await p1;
	assert.equal(r.status, "failed");
	assert.match(r.error, /boom/);
	w.procs[0].emit("close", 0, null); // duplicate close must not release again
	w.procs[0].emit("error", new Error("late"));
	await tick();
	assert.equal(w.procs.length, 2, "only one waiter starts");
	assert.deepEqual(w.runner.stats(), { active: 1, queued: 1 });
	w.procs[1].exit(0);
	await tick();
	w.procs[2].exit(0);
	await Promise.all([p2, p3]);
});

test("error on a child that never started settles immediately", async () => {
	const w = world(1);
	const p = w.runner.run(spec("a"));
	await tick();
	w.procs[0].pid = undefined;
	w.procs[0].emit("error", new Error("ENOENT"));
	const r = await p;
	assert.equal(r.status, "failed");
	assert.match(r.error, /ENOENT/);
	assert.deepEqual(w.runner.stats(), { active: 0, queued: 0 });
});

test("aborting a queued run never prepares or spawns and does not block others", async () => {
	const w = world(1);
	const ac = new AbortController();
	let prepared = false;
	const p1 = w.runner.run(spec("a"));
	const p2 = w.runner.run({ ...spec("b"), signal: ac.signal, prepare: () => ((prepared = true), { command: "x", args: [], cwd: "." }) });
	const p3 = w.runner.run(spec("c"));
	await tick();
	ac.abort();
	const r2 = await p2;
	assert.equal(r2.status, "aborted");
	assert.equal(r2.spawned, false);
	assert.deepEqual(w.runner.stats(), { active: 1, queued: 1 });
	w.procs[0].exit(0);
	await tick();
	assert.equal(prepared, false);
	assert.equal(w.procs.length, 2);
	assert.deepEqual(w.spawnCalls[1].args, ["c"]);
	w.procs[1].exit(0);
	await Promise.all([p1, p3]);
});

test("an already-aborted signal never spawns", async () => {
	const w = world();
	const ac = new AbortController();
	ac.abort();
	const r = await w.runner.run(spec("a", { signal: ac.signal }));
	assert.equal(r.status, "aborted");
	assert.equal(w.spawnCalls.length, 0);
	assert.deepEqual(w.runner.stats(), { active: 0, queued: 0 });
});

test("abort after slot acquisition but before spawn does not spawn", async () => {
	const w = world();
	const ac = new AbortController();
	const cleaned = [];
	const r = await w.runner.run({
		signal: ac.signal,
		prepare: async () => {
			ac.abort();
			return { command: "pi", args: [], cwd: "." };
		},
		cleanup: () => cleaned.push(1),
	});
	assert.equal(r.status, "aborted");
	assert.equal(w.spawnCalls.length, 0);
	assert.deepEqual(cleaned, [1]);
	assert.deepEqual(w.runner.stats(), { active: 0, queued: 0 });
});

test("aborting a running child sends TERM, keeps the slot until close, then reports aborted", async () => {
	const w = world(1);
	const ac = new AbortController();
	const p1 = w.runner.run(spec("a", { signal: ac.signal }));
	const p2 = w.runner.run(spec("b"));
	await tick();
	ac.abort();
	assert.deepEqual(w.procs[0].kills, ["SIGTERM"]);
	assert.equal(w.timers.length, 1);
	assert.equal(w.timers[0].ms, 5000);
	await tick();
	assert.equal(w.procs.length, 1, "slot still held while the child lives");
	w.procs[0].exit(0, null);
	const r = await p1;
	assert.equal(r.status, "aborted");
	assert.equal(w.timers[0].cleared, true);
	await tick();
	assert.equal(w.procs.length, 2);
	w.procs[1].exit(0);
	await p2;
});

test("a child that ignores TERM is killed after the grace period and the slot is held until close", async () => {
	const w = world(1);
	const ac = new AbortController();
	const p1 = w.runner.run(spec("a", { signal: ac.signal }));
	const p2 = w.runner.run(spec("b"));
	await tick();
	ac.abort();
	w.timers[0].fn();
	assert.deepEqual(w.procs[0].kills, ["SIGTERM", "SIGKILL"]);
	await tick();
	assert.equal(w.procs.length, 1);
	w.procs[0].exit(null, "SIGKILL");
	assert.equal((await p1).status, "aborted");
	await tick();
	assert.equal(w.procs.length, 2);
	w.procs[1].exit(0);
	await p2;
});

test("no KILL is sent when the child already exited before the grace timer fires", async () => {
	const w = world();
	const ac = new AbortController();
	const p = w.runner.run(spec("a", { signal: ac.signal }));
	await tick();
	ac.abort();
	w.procs[0].exitCode = 0; // exited, close not yet delivered
	w.timers[0].fn();
	assert.deepEqual(w.procs[0].kills, ["SIGTERM"]);
	w.procs[0].emit("close", 0, null);
	await p;
});

test("a detached child is signalled as a process group, SIGKILL included", async () => {
	const groupKills = [];
	const w = world(4, (pid, sig) => groupKills.push([pid, sig]));
	const ac = new AbortController();
	const p = w.runner.run({ ...spec("a", { signal: ac.signal }), prepare: () => ({ command: "pi", args: [], cwd: "/", detached: true, env: { X: "1" } }) });
	await tick();
	assert.equal(w.spawnCalls[0].options.detached, true);
	assert.deepEqual(w.spawnCalls[0].options.env, { X: "1" });
	ac.abort();
	// The group leader may be gone while a descendant still holds the pipes open.
	w.procs[0].exitCode = 0;
	w.timers[0].fn();
	assert.deepEqual(groupKills, [[-1000, "SIGTERM"], [-1000, "SIGKILL"]]);
	assert.deepEqual(w.procs[0].kills, []);
	w.procs[0].emit("close", 0, null);
	assert.equal((await p).status, "aborted");
});

test("a group kill that fails falls back to the direct pid, and children are not detached by default", async () => {
	const w = world(4, () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); });
	const ac = new AbortController();
	const detached = w.runner.run({ ...spec("a", { signal: ac.signal }), prepare: () => ({ command: "pi", args: [], cwd: "/", detached: true }) });
	const plain = w.runner.run(spec("b"));
	await tick();
	assert.equal(w.spawnCalls[0].options.detached, true);
	assert.equal(w.spawnCalls[1].options.detached, false);
	ac.abort();
	assert.deepEqual(w.procs[0].kills, ["SIGTERM"]);
	w.procs[0].exit(null, "SIGTERM");
	w.procs[1].exit(0);
	assert.equal((await detached).status, "aborted");
	assert.equal((await plain).status, "completed");
});

test("a throwing kill does not break settlement", async () => {
	const w = world();
	const ac = new AbortController();
	const p = w.runner.run(spec("a", { signal: ac.signal }));
	await tick();
	w.procs[0].killThrows = true;
	ac.abort();
	w.procs[0].exit(0);
	assert.equal((await p).status, "aborted");
});

for (const stream of ["stdout", "stderr"]) {
	test(`a throwing ${stream} callback fails the child without escaping dispatch`, async () => {
		const w = world(1);
		const p = w.runner.run(spec("a", { [stream === "stdout" ? "onStdout" : "onStderr"]: () => { throw new Error("observer failed"); } }));
		await tick();
		assert.doesNotThrow(() => w.procs[0][stream].emit("data", Buffer.from("x")));
		assert.deepEqual(w.procs[0].kills, ["SIGTERM"]);
		w.procs[0].exit(0);
		const result = await p;
		assert.equal(result.status, "failed");
		assert.match(result.error, /observer failed/);
		assert.deepEqual(w.runner.stats(), { active: 0, queued: 0 });
	});
}

test("abort listeners and timers are cleaned after normal completion", async () => {
	const w = world();
	let added = 0;
	let removed = 0;
	const signal = {
		aborted: false,
		addEventListener: () => added++,
		removeEventListener: () => removed++,
	};
	const p = w.runner.run(spec("a", { signal }));
	await tick();
	w.procs[0].exit(0);
	await p;
	assert.equal(added, 1);
	assert.equal(removed, 1);
	assert.equal(w.timers.filter((t) => !t.cleared).length, 0);
});

test("abort listener is removed when a queued run is aborted", async () => {
	const w = world(1);
	let removed = 0;
	const real = new AbortController();
	const signal = {
		get aborted() {
			return real.signal.aborted;
		},
		addEventListener: (...a) => real.signal.addEventListener(...a),
		removeEventListener: (...a) => (removed++, real.signal.removeEventListener(...a)),
	};
	const p1 = w.runner.run(spec("a"));
	const p2 = w.runner.run(spec("b", { signal }));
	await tick();
	real.abort();
	await p2;
	assert.ok(removed >= 1);
	w.procs[0].exit(0);
	await p1;
});

test("shutdown aborts queued and active runs and waits for children to terminate", async () => {
	const w = world(1);
	const p1 = w.runner.run(spec("a"));
	const p2 = w.runner.run(spec("b"));
	await tick();
	let done = false;
	const s = w.runner.shutdown().then(() => (done = true));
	await tick();
	assert.deepEqual(w.procs[0].kills, ["SIGTERM"]);
	assert.equal((await p2).status, "aborted");
	assert.equal(w.procs.length, 1);
	assert.equal(done, false, "shutdown waits for the child");
	w.timers[0].fn();
	assert.deepEqual(w.procs[0].kills, ["SIGTERM", "SIGKILL"]);
	await tick();
	assert.equal(done, false);
	w.procs[0].exit(null, "SIGKILL");
	await s;
	assert.equal(done, true);
	assert.equal((await p1).status, "aborted");
	assert.deepEqual(w.runner.stats(), { active: 0, queued: 0 });
});

test("shutdown is idempotent and later runs are aborted without spawning", async () => {
	const w = world();
	const p = w.runner.run(spec("a"));
	await tick();
	const s1 = w.runner.shutdown();
	const s2 = w.runner.shutdown();
	w.procs[0].exit(0);
	await Promise.all([s1, s2, p]);
	await w.runner.shutdown();
	assert.deepEqual(w.procs[0].kills, ["SIGTERM"]);
	const r = await w.runner.run(spec("late"));
	assert.equal(r.status, "aborted");
	assert.equal(w.spawnCalls.length, 1);
});

test("1000 submissions share one abort listener and clean up after cancellation", async () => {
	const w = world(4);
	const controller = new AbortController();
	let added = 0;
	let removed = 0;
	const signal = {
		get aborted() { return controller.signal.aborted; },
		addEventListener: (...args) => { added++; controller.signal.addEventListener(...args); },
		removeEventListener: (...args) => { removed++; controller.signal.removeEventListener(...args); },
	};
	const runs = Array.from({ length: 1000 }, (_, n) => w.runner.run(spec(String(n), { signal })));
	await tick();
	assert.equal(added, 1);
	assert.deepEqual(w.runner.stats(), { active: 4, queued: 996 });
	for (let wave = 0; wave < 10; wave++) {
		for (const proc of w.procs.filter((p) => p.exitCode === null && p.signalCode === null)) proc.exit(0);
		await tick();
		assert.ok(w.runner.stats().active <= 4);
	}
	controller.abort();
	for (const proc of w.procs.filter((p) => p.exitCode === null && p.signalCode === null)) proc.exit(null, 'SIGTERM');
	const results = await Promise.all(runs);
	assert.equal(results.filter((r) => r.status === 'completed').length, 40);
	assert.equal(results.filter((r) => r.status === 'aborted').length, 960);
	assert.deepEqual(w.runner.stats(), { active: 0, queued: 0 });
	assert.equal(removed, 1);
	await w.runner.shutdown();
});

test("shutdown with nothing running resolves", async () => {
	const w = world();
	await w.runner.shutdown();
});

// ---------------------------------------------------------------------------
// Real extension loader + fake child Pi process (no model calls)
// ---------------------------------------------------------------------------
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PI_CORE = process.env.PI_CORE_DIR ?? (() => {
	const install = process.env.PI_MANAGED_INSTALL_ROOT ?? path.join(os.homedir(), ".pi/agent/install");
	const version = fs.readFileSync(path.join(install, "current-version"), "utf8").trim();
	return path.join(install, "releases", version, "node_modules/@earendil-works/pi-coding-agent");
})();
const here = path.dirname(fileURLToPath(import.meta.url));
const { loadExtensions } = await import(`${PI_CORE}/dist/core/extensions/loader.js`);

const FAKE_PI = `
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const task = process.argv.at(-1).replace(/^Task: /, "");
const log = process.env.FAKE_PI_LOG;
const note = (k) => fs.appendFileSync(log, k + " " + process.pid + " " + JSON.stringify(task) + "\\n");
note("S");
const U = (n, extra = {}) => ({ input: 10 * n, output: 5 * n, cacheRead: 3 * n, cacheWrite: 2 * n, totalTokens: 20 * n, cost: { input: 0.25 * n, output: 0.5 * n, cacheRead: 0.125 * n, cacheWrite: 0.0625 * n, total: 0.9375 * n }, ...extra });
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const assistantUsage = (u) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "step" }], usage: u, model: "fake", stopReason: "toolUse" } });
if (/usage-early/.test(task)) emit(assistantUsage(U(1)));
let done = false;
const finish = (code) => {
	if (done) return;
	done = true;
	const text = /huge/.test(task) ? "answer " + "é".repeat(1024 * 1024) : /big/.test(task) ? "x".repeat(40000) : "cwd=" + process.cwd() + " task=" + task + " args=" + process.argv.slice(2, -1).join(" ") + (/showenv/.test(task) ? " depth=" + process.env.PI_SUBAGENT_DEPTH + " groupLeader=" + (Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)])) === process.pid) : "");
	if (/noisy/.test(task)) for (let i = 0; i < 100; i++) process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "n".repeat(20000) }], usage: { input: 1, output: 1 }, stopReason: "stop" } }) + "\\n");
	if (/usage(?!-early)/.test(task)) {
		emit(assistantUsage(U(1, { reasoning: 2, cacheWrite1h: 1 })));
		const toolResult = { role: "toolResult", toolCallId: "c1", toolName: "subagent", content: [{ type: "text", text: "nested" }], usage: U(1), isError: false };
		emit({ type: "message_end", message: toolResult });
		emit({ type: "tool_result_end", message: toolResult });
	}
	const sendFinal = () => process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: /multipart/.test(task) ? [{ type: "text", text: "alpha" }, { type: "toolCall", id: "c", name: "read", arguments: {} }, { type: "text", text: "é-beta" }] : /multibig/.test(task) ? [{ type: "text", text: "a".repeat(40000) }, { type: "text", text: "é".repeat(20000) }] : /emptytext/.test(task) ? [{ type: "text", text: "" }] : [{ type: "text", text }], usage: /usage/.test(task) ? U(2) : { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 }, model: "fake", stopReason: /large-reason/.test(task) ? "r".repeat(2 * 1024 * 1024) : "stop", errorMessage: /large-error/.test(task) ? "error " + "e".repeat(2 * 1024 * 1024) : undefined } }) + "\\n", () => { note("E"); process.exit(code); });
	if (/oversized/.test(task)) process.stdout.write("x".repeat(9 * 1024 * 1024) + (/complete/.test(task) ? "\\n" : ""), sendFinal);
	else if (/stderr/.test(task)) process.stderr.write("z".repeat(200000) + "TAIL", sendFinal);
	else sendFinal();
};
process.on("SIGTERM", () => { note("T"); done = true; process.exit(0); });
const m = /sleep:(\\d+)/.exec(task);
if (/gate/.test(task)) {
	const poll = setInterval(() => {
		if (fs.existsSync(log + ".release")) { clearInterval(poll); finish(0); }
	}, 10);
} else setTimeout(() => finish(/fail/.test(task) ? 3 : 0), m ? Number(m[1]) : 0);
`;

const AGENT = (name, body = "You are a test agent.") =>
	`---\nname: ${name}\ndescription: test ${name}\ntools: read\n---\n${body}\n`;

function makeEnv() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-")));
	const agentDir = path.join(root, "agent");
	const tmp = path.join(root, "tmp");
	const log = path.join(root, "fake.log");
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.mkdirSync(tmp);
	fs.mkdirSync(path.join(root, "a"));
	fs.mkdirSync(path.join(root, "b"));
	fs.writeFileSync(path.join(agentDir, "agents", "worker.md"), AGENT("worker"));
	fs.writeFileSync(path.join(agentDir, "agents", "reviewer.md"), AGENT("reviewer"));
	fs.writeFileSync(log, "");
	const fakePi = path.join(root, "fake-pi.mjs");
	fs.writeFileSync(fakePi, FAKE_PI);
	return { root, agentDir, tmp, log, fakePi };
}

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "FAKE_PI_LOG", "TMPDIR", "PI_SUBAGENT_MAX_CONCURRENCY", "PI_SUBAGENT_DEPTH"];

async function withExtension(maxConcurrency, fn, depth) {
	const e = makeEnv();
	const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	const savedArgv1 = process.argv[1];
	process.env.PI_CODING_AGENT_DIR = e.agentDir;
	process.env.FAKE_PI_LOG = e.log;
	process.env.TMPDIR = e.tmp;
	if (maxConcurrency === undefined) delete process.env.PI_SUBAGENT_MAX_CONCURRENCY;
	else process.env.PI_SUBAGENT_MAX_CONCURRENCY = maxConcurrency;
	if (depth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
	else process.env.PI_SUBAGENT_DEPTH = depth;
	process.argv[1] = e.fakePi;
	let ext;
	try {
		const loaded = await loadExtensions([path.join(here, "index.ts")], e.root);
		assert.deepEqual(loaded.errors, []);
		ext = loaded.extensions[0];
		const tool = ext.tools.get("subagent").definition;
		const ctx = { cwd: e.root, model: undefined, thinkingLevel: undefined };
		const call = (params, signal, onUpdate) => tool.execute("id", params, signal, onUpdate, ctx);
		const shutdown = async () => {
			for (const h of ext.handlers.get("session_shutdown") ?? []) await h({ type: "session_shutdown", reason: "reload" }, {});
		};
		const events = () =>
			fs
				.readFileSync(e.log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => ({ kind: l[0], pid: Number(l.split(" ")[1]) }));
		await fn({ e, ext, tool, call, shutdown, events });
	} finally {
		try {
			for (const h of ext?.handlers.get("session_shutdown") ?? []) await h({ type: "session_shutdown", reason: "quit" }, {});
		} catch {}
		process.argv[1] = savedArgv1;
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
		fs.rmSync(e.root, { recursive: true, force: true });
	}
}

const maxOverlap = (events) => {
	let cur = 0;
	let max = 0;
	for (const ev of events) {
		if (ev.kind === "S") max = Math.max(max, ++cur);
		else if (ev.kind === "E" || ev.kind === "T") cur--;
	}
	return max;
};
// Pi's own loader leaves a jiti cache dir in TMPDIR; only subagent prompt dirs matter.
const promptTempDirs = (e) => fs.readdirSync(e.tmp).filter((n) => n.startsWith("pi-subagent-"));
const text = (r) => r.content[0].text;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 5000) {
	const t = Date.now();
	while (!pred()) {
		if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
		await sleep(10);
	}
}
const pidAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const P = (n, extra = "") => ({ agent: "worker", task: `t${n} ${extra}` });

test("loader registers the subagent tool and a session_shutdown handler", async () => {
	await withExtension(undefined, async ({ ext, tool }) => {
		assert.equal(tool.name, "subagent");
		assert.equal(ext.handlers.get("session_shutdown")?.length, 1);
		assert.match(tool.description, /maximum 8/);
		assert.equal(ext.tools.has("consult_advisor"), false);
	});
});

test("the tool carries its own system-prompt guidance, so no AGENTS.md entry is required", async () => {
	await withExtension(undefined, async ({ tool }) => {
		assert.ok(tool.promptSnippet);
		assert.ok(tool.promptGuidelines.length > 0);
		assert.ok(tool.promptGuidelines.every((g) => typeof g === "string" && g.length > 0));
	});
});

test("the schema offers only agent, task, tasks and cwd", async () => {
	await withExtension(undefined, async ({ tool }) => {
		assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["agent", "cwd", "task", "tasks"]);
		assert.equal(tool.parameters.properties.tasks.maxItems, 8);
	});
});

const writeRole = (e, name, tools, description = `test ${name}`) =>
	fs.writeFileSync(path.join(e.agentDir, "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\n---\nYou are ${name}.\n`);

test("children receive PI_SUBAGENT_DEPTH, one above the caller, and are detached only from depth 0", async () => {
	await withExtension(undefined, async ({ call }) => {
		assert.match(text(await call({ agent: "worker", task: "showenv" })), /depth=1 groupLeader=true/);
	});
	await withExtension(undefined, async ({ call }) => {
		assert.match(text(await call({ agent: "worker", task: "showenv" })), /depth=2 groupLeader=false/);
	}, "1");
});

test("at depth 0 every role is listed and callable", async () => {
	await withExtension(undefined, async ({ e, ext, call }) => {
		writeRole(e, "editor", "read, edit, write, subagent");
		const loaded = await loadExtensions([path.join(here, "index.ts")], e.root);
		const description = loaded.extensions[0].tools.get("subagent").definition.description;
		assert.match(description, /worker: test worker/);
		assert.match(description, /editor: test editor/);
		assert.equal(text(await call({ agent: "editor", task: "go" })).includes("task=go"), true);
	});
});

test("at depth 1 only read-only roles are listed and callable, and editors are refused before any spawn", async () => {
	await withExtension(undefined, async ({ e, call, events }) => {
		writeRole(e, "advisor", "read, grep, bash");
		writeRole(e, "editor", "read, edit");
		writeRole(e, "writer", "read, write");
		writeRole(e, "delegator", "read, subagent");
		const loaded = await loadExtensions([path.join(here, "index.ts")], e.root);
		const description = loaded.extensions[0].tools.get("subagent").definition.description;
		assert.match(description, /advisor: test advisor/);
		assert.match(description, /worker: test worker/);
		assert.doesNotMatch(description, /editor:|writer:|delegator:/);
		assert.match(description, /read-only roles only/);

		for (const agent of ["editor", "writer", "delegator"]) {
			const refused = await call({ agent, task: "go" });
			assert.equal(refused.isError, true);
			assert.match(text(refused), new RegExp(`read-only roles.*Refused: ${agent}`));
		}
		const mixed = await call({ tasks: [{ agent: "worker", task: "fine" }, { agent: "editor", task: "no" }] });
		assert.equal(mixed.isError, true);
		assert.equal(events().length, 0, "a refused batch spawns nothing");

		const allowed = await call({ tasks: [{ agent: "advisor", task: "showenv" }, { agent: "worker", task: "showenv" }] });
		assert.match(text(allowed), /2\/2 succeeded/);
		assert.match(text(allowed), /depth=2/);
	}, "1");
});

for (const depth of ["2", "5"]) {
	test(`at depth ${depth} the tool refuses with a clear error and never spawns`, async () => {
		await withExtension(undefined, async ({ call, events }) => {
			for (const params of [{ agent: "worker", task: "x" }, { tasks: [P(1)] }]) {
				const r = await call(params);
				assert.equal(r.isError, true);
				assert.match(text(r), /nesting is limited to one level/);
			}
			assert.equal(events().length, 0);
		}, depth);
	});
}

test("guidelines are parent-oriented at depth 0 and delegation-limited at depth 1", async () => {
	await withExtension(undefined, async ({ tool }) => {
		const guidance = tool.promptGuidelines.join("\n");
		assert.ok(tool.promptGuidelines.length <= 6);
		assert.match(guidance, /overlapping files/);
		assert.match(guidance, /settle shared contracts/);
		assert.match(guidance, /generated files, lockfiles/);
		assert.match(guidance, /call the advisor once on the combined diff/);
		assert.match(guidance, /Redirect noisy command output to a file/);
		assert.match(guidance, /unverified/);
		assert.doesNotMatch(guidance, /cannot delegate edits/);
	});
	await withExtension(undefined, async ({ tool }) => {
		const guidance = tool.promptGuidelines.join("\n");
		assert.match(guidance, /Ask the advisor once for a hard decision and the explorer for lookups\. You cannot delegate edits\./);
		assert.doesNotMatch(guidance, /parallel call|combined diff before reporting done/);
	}, "1");
});

test("skipped role files are named in the roster and never block valid roles", async () => {
	await withExtension(undefined, async ({ e }) => {
		fs.writeFileSync(path.join(e.agentDir, "agents", "explorer.md"), "---\nname: explorer\ndescription: Look: around\ntools: read\n---\nbody\n");
		fs.writeFileSync(path.join(e.agentDir, "agents", "notools.md"), "---\nname: notools\ndescription: x\n---\nbody\n");
		const loaded = await loadExtensions([path.join(here, "index.ts")], e.root);
		assert.deepEqual(loaded.errors, []);
		const description = loaded.extensions[0].tools.get("subagent").definition.description;
		assert.match(description, /worker: test worker/);
		assert.match(description, /Skipped agent files: .*explorer\.md \(invalid frontmatter\)/);
		assert.match(description, /notools\.md \(missing name, description or tools\)/);
	});
	await withExtension(undefined, async ({ tool }) => {
		assert.doesNotMatch(tool.description, /Skipped/);
	});
});

test("the shipped starter roles all load without being skipped", async () => {
	await withExtension(undefined, async ({ e }) => {
		const starters = path.join(here, "agents");
		for (const file of fs.readdirSync(starters).filter((f) => f.endsWith(".md"))) {
			fs.copyFileSync(path.join(starters, file), path.join(e.agentDir, "agents", file));
		}
		const loaded = await loadExtensions([path.join(here, "index.ts")], e.root);
		const description = loaded.extensions[0].tools.get("subagent").definition.description;
		assert.doesNotMatch(description, /Skipped/);
		for (const name of ["advisor", "explorer", "implementer"]) assert.match(description, new RegExp(`${name}: `));
	});
});

test("the tool description lists the available agents so no AGENTS.md roster is needed", async () => {
	await withExtension(undefined, async ({ tool }) => {
		assert.match(tool.description, /Available agents: .*worker: test worker/);
		assert.match(tool.description, /Available agents: .*reviewer: test reviewer/);
	});
});

test("oversized and ambiguous calls are rejected without spawning", async () => {
	await withExtension(undefined, async ({ call, events }) => {
		const oversized = await call({ tasks: Array.from({ length: 9 }, (_, n) => P(n)) });
		assert.equal(oversized.isError, true);
		assert.match(text(oversized), /Too many parallel tasks \(9\)\. Max is 8/);
		assert.match(text(await call({ agent: "worker", task: "x", tasks: [P(1)] })), /Invalid parameters/);
		assert.match(text(await call({})), /Invalid parameters/);
		assert.equal(events().length, 0);
	});
});

for (const [value, expected] of [[undefined, 4], ["2", 2], ["99", 16], ["0", 1], ["abc", 4]]) {
	test(`PI_SUBAGENT_MAX_CONCURRENCY=${value} gives a limit of ${expected}`, async () => {
		await withExtension(value, async ({ tool, e, call, events }) => {
			assert.match(tool.description, new RegExp(`At most ${expected} subagent processes`));
			const count = Math.min(expected, 8);
			const pending = call({ tasks: Array.from({ length: 8 }, (_, n) => P(n, "gate")) });
			await until(() => events().filter((ev) => ev.kind === "S").length === count);
			await sleep(100);
			assert.equal(maxOverlap(events()), count);
			fs.writeFileSync(e.log + ".release", "go");
			assert.ok((await pending).details.results.every((r) => r.status === "completed"));
			assert.equal(maxOverlap(events()), count);
		});
	});
}

test("overlapping single and parallel calls share one limiter", async () => {
	await withExtension("2", async ({ call, events }) => {
		const results = await Promise.all([
			call({ tasks: [1, 2, 3].map((n) => P(n, "sleep:150")) }),
			call({ agent: "worker", task: "solo sleep:150" }),
			call({ tasks: [P(7, "sleep:150"), P(8, "sleep:150")] }),
		]);
		assert.equal(events().filter((x) => x.kind === "S").length, 6);
		assert.equal(maxOverlap(events()), 2);
		assert.ok(results.every((r) => !r.isError));
	});
});

test("results keep input order, repeated roles and per-task cwd, with explicit statuses", async () => {
	await withExtension(undefined, async ({ e, call }) => {
		const r = await call({
			tasks: [
				{ agent: "worker", task: "first sleep:200", cwd: path.join(e.root, "a") },
				{ agent: "reviewer", task: "second" },
				{ agent: "worker", task: "third", cwd: path.join(e.root, "b") },
			],
		});
		const res = r.details.results;
		assert.deepEqual(res.map((x) => x.agent), ["worker", "reviewer", "worker"]);
		assert.deepEqual(res.map((x) => x.status), ["completed", "completed", "completed"]);
		const out = res.map((x) => x.messages[0].content[0].text);
		assert.match(out[0], new RegExp(`cwd=${path.join(e.root, "a")} task=first`));
		assert.match(out[1], new RegExp(`cwd=${e.root} task=second`));
		assert.match(out[2], new RegExp(`cwd=${path.join(e.root, "b")} task=third`));
		const t = text(r);
		assert.ok(t.indexOf("first") < t.indexOf("second") && t.indexOf("second") < t.indexOf("third"));
	});
});

test("single mode reports completed status, exit code, and cleans prompt temp files", async () => {
	await withExtension(undefined, async ({ e, call }) => {
		const r = await call({ agent: "worker", task: "hello" });
		assert.equal(r.details.results[0].status, "completed");
		assert.equal(r.details.results[0].exitCode, 0);
		assert.match(text(r), /task=hello/);
		assert.match(text(r), /--append-system-prompt/);
		assert.deepEqual(promptTempDirs(e), []);
	});
});

test("a failing task keeps the other batch results", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ tasks: [P(1), { agent: "worker", task: "fail" }, P(3)] });
		assert.deepEqual(r.details.results.map((x) => x.status), ["completed", "failed", "completed"]);
		assert.equal(r.details.results[1].exitCode, 3);
		assert.match(text(r), /2\/3 succeeded/);
		assert.match(text(r), /### \[worker\] failed \(exit 3\)\n/);
		assert.doesNotMatch(text(r), /failed \(stop\)/);
	});
});

test("a single task failing with exit 3 after a normal stop reports the exit code", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ agent: "worker", task: "fail" });
		assert.equal(r.isError, true);
		assert.equal(r.details.results[0].stopReason, "stop");
		assert.match(text(r), /^Agent failed \(exit 3\): /);
		assert.doesNotMatch(text(r), /Agent stop/);
	});
});

test("an unknown agent fails immediately without waiting for a slot", async () => {
	await withExtension("1", async ({ call, events }) => {
		const long = call({ agent: "worker", task: "long sleep:1500" });
		await until(() => events().length > 0);
		const t0 = Date.now();
		const r = await call({ tasks: [{ agent: "ghost", task: "x" }] });
		assert.ok(Date.now() - t0 < 1000);
		assert.equal(r.details.results[0].status, "failed");
		assert.match(r.details.results[0].stderr, /Unknown agent: "ghost"/);
		await long;
		assert.equal(events().filter((x) => x.kind === "S").length, 1);
	});
});

test("throwing progress observers do not crash or reject a batch", async () => {
	await withExtension(undefined, async ({ e, call }) => {
		const r = await call({ tasks: [P(1), P(2)] }, undefined, () => { throw new Error("UI observer failed"); });
		assert.deepEqual(r.details.results.map((r) => r.status), ["completed", "completed"]);
		assert.deepEqual(promptTempDirs(e), []);
	});
});

test("queued tasks report queued then running through progress updates", async () => {
	await withExtension("1", async ({ call }) => {
		const seen = [];
		await call({ tasks: [P(1, "sleep:100"), P(2)] }, undefined, (u) => seen.push(u.details.results.map((x) => x.status).join(",")));
		assert.ok(seen.includes("running,queued"), seen.join(" | "));
		assert.equal(seen.at(-1), "completed,completed");
	});
});

test("aborting a batch aborts running and queued tasks, queued tasks never spawn, results are retained", async () => {
	await withExtension("1", async ({ call, events }) => {
		const ac = new AbortController();
		const p = call({ tasks: [P(1, "sleep:10000"), P(2), P(3)] }, ac.signal);
		await until(() => events().length > 0);
		ac.abort();
		const r = await p;
		assert.deepEqual(r.details.results.map((x) => x.status), ["aborted", "aborted", "aborted"]);
		assert.equal(r.details.results.length, 3);
		assert.equal(events().filter((x) => x.kind === "S").length, 1);
		assert.match(text(r), /### \[worker\] aborted/);
	});
});

test("aborting a single call reports an aborted error result", async () => {
	await withExtension(undefined, async ({ e, call, events }) => {
		const ac = new AbortController();
		const p = call({ agent: "worker", task: "sleep:10000" }, ac.signal);
		await until(() => events().length > 0);
		ac.abort();
		const r = await p;
		assert.equal(r.isError, true);
		assert.equal(r.details.results[0].status, "aborted");
		assert.deepEqual(promptTempDirs(e), []);
	});
});

test("model-visible output is capped at 16 KB per task", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ agent: "worker", task: "big" });
		assert.ok(Buffer.byteLength(text(r)) < 16 * 1024 + 200);
		assert.match(text(r), /Output truncated/);
		assert.equal(r.details.results[0].messages[0].content[0].text.length, 40000);
		const p = await call({ tasks: [{ agent: "worker", task: "big" }, P(2)] });
		assert.ok(Buffer.byteLength(text(p)) < 2 * 16 * 1024 + 1000);
	});
});

test("a noisy task bounds history while retaining final output and total usage", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ agent: "worker", task: "noisy" });
		const result = r.details.results[0];
		assert.ok(Buffer.byteLength(JSON.stringify(result.messages)) <= 1024 * 1024);
		assert.ok(result.output.omittedMessages > 0);
		assert.equal(result.usage.turns, 101);
		assert.equal(result.usage.input, 101);
		assert.match(text(r), /task=noisy/);
		assert.doesNotMatch(text(r), /discarded/);
	});
});

test("a huge final message keeps a bounded preview and explicit omission metadata", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ agent: "worker", task: "huge" });
		const result = r.details.results[0];
		assert.equal(result.status, "completed");
		assert.ok(Buffer.byteLength(JSON.stringify(result.messages)) <= 1024 * 1024);
		assert.equal(result.output.shortenedMessages, 1);
		assert.match(text(r), /answer /);
		assert.match(text(r), /not retained/);
		assert.match(result.finalOutput, /not retained/);
		assert.ok(Buffer.byteLength(result.finalOutput) <= 64 * 1024);
	});
});

for (const task of ["oversized", "oversized-complete"]) {
	test(`${task} stdout fails the task rather than reporting success`, async () => {
		await withExtension(undefined, async ({ e, call }) => {
			const r = await call({ agent: "worker", task });
			assert.equal(r.isError, true);
			assert.equal(r.details.results[0].status, "failed");
			assert.match(text(r), /stdout line exceeded/);
			assert.deepEqual(promptTempDirs(e), []);
		});
	});
}

test("stderr is bounded and omissions are counted in details", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ agent: "worker", task: "stderr" });
		const result = r.details.results[0];
		assert.ok(Buffer.byteLength(result.stderr) <= 64 * 1024);
		assert.ok(result.output.stderrOmittedBytes > 0);
		assert.ok(result.stderr.endsWith("TAIL"));
	});
});

test("large child errors and failure reasons cannot bypass retained or batch budgets", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ tasks: [{ agent: 'worker', task: 'fail-large-error-large-reason' }, ...Array.from({ length: 7 }, (_, n) => P(n))] });
		const failed = r.details.results[0];
		assert.equal(failed.status, 'failed');
		assert.ok(Buffer.byteLength(failed.errorMessage) <= 64 * 1024);
		assert.ok(Buffer.byteLength(failed.stopReason) <= 128);
		assert.ok(Buffer.byteLength(text(r)) <= 128 * 1024);
	});
});

test("short results return unused batch budget to longer results", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ tasks: [P(0, 'big'), ...Array.from({ length: 7 }, (_, n) => P(n + 1))] });
		assert.match(text(r).split('\n\n---\n\n')[0], /x{15000}/);
		assert.ok(Buffer.byteLength(text(r)) <= 128 * 1024);
	});
});

test("a large batch has a fair bounded model-facing output budget", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ tasks: Array.from({ length: 8 }, (_, n) => P(n, "big")) });
		assert.ok(Buffer.byteLength(text(r)) <= 128 * 1024);
		assert.equal((text(r).match(/### \[worker\] completed/g) ?? []).length, 8);
		assert.equal((text(r).match(/Output truncated/g) ?? []).length, 8);
		assert.equal(r.details.results.length, 8);
	});
});

test("session_shutdown aborts queued and active work and waits until children are gone", async () => {
	await withExtension("1", async ({ call, shutdown, events, e }) => {
		const p = call({ tasks: [P(1, "sleep:10000"), P(2), P(3)] });
		await until(() => events().length > 0);
		const pid = events()[0].pid;
		assert.equal(pidAlive(pid), true);
		await shutdown();
		assert.equal(pidAlive(pid), false, "child is terminated when shutdown returns");
		const r = await p;
		assert.deepEqual(r.details.results.map((x) => x.status), ["aborted", "aborted", "aborted"]);
		await shutdown(); // idempotent
		const late = await call({ agent: "worker", task: "late" });
		assert.equal(late.details.results[0].status, "aborted");
		assert.equal(events().filter((x) => x.kind === "S").length, 1);
		assert.deepEqual(promptTempDirs(e), []);
	});
});

test("results without status (older stored calls) still render", async () => {
	await withExtension(undefined, async ({ tool }) => {
		const theme = { fg: (_c, t) => t, bold: (t) => t };
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
		const msg = (t) => [{ role: "assistant", content: [{ type: "text", text: t }] }];
		const legacy = (extra) => ({ agent: "worker", task: "t", usage, stderr: "", ...extra });
		const render = (details) =>
			tool
				.renderResult({ content: [{ type: "text", text: "x" }], details }, { expanded: false }, theme, {})
				.render(120)
				.join("\n");
		const base = {};
		const out = render({
			...base,
			mode: "parallel",
			results: [
				legacy({ exitCode: 0, messages: msg("fine") }),
				legacy({ exitCode: 1, messages: msg("bad") }),
				legacy({ exitCode: -1, messages: [] }),
			],
		});
		assert.match(out, /2\/3 done, 1 running, 0 queued/);
		assert.match(out, /✓/);
		assert.match(out, /✗/);
		assert.match(out, /\(running\.\.\.\)/);
		const single = render({ ...base, mode: "single", results: [legacy({ exitCode: 0, messages: msg("legacy ok") })] });
		assert.match(single, /legacy ok/);
		const modern = render({
			...base,
			mode: "parallel",
			results: [legacy({ exitCode: -1, status: "queued", messages: [] }), legacy({ exitCode: 1, status: "aborted", messages: [] })],
		});
		assert.match(modern, /\(queued\.\.\.\)/);
		assert.match(modern, /⊘/);
	});
});

test("rendering uses the retained final answer after history eviction", async () => {
	await withExtension(undefined, async ({ tool }) => {
		const theme = { fg: (_c, t) => t, bold: (t) => t };
		const result = { agent: 'worker', task: 'x', status: 'completed', exitCode: 0, messages: [], stderr: '', finalOutput: 'survived final answer', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } };
		for (const mode of ['single', 'parallel']) for (const expanded of [false, true]) {
			const rendered = tool.renderResult({ content: [{ type: 'text', text: 'x' }], details: { mode, results: [result] } }, { expanded }, theme, {}).render(120).join('\n');
			assert.match(rendered, /survived final answer/);
		}
	});
});

test("pending, aborted and failed states render explicit icons in both views", async () => {
	await withExtension(undefined, async ({ tool }) => {
		const theme = { fg: (_c, t) => t, bold: (t) => t };
		const usage = { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 };
		const msg = (t) => [{ role: "assistant", content: [{ type: "text", text: t }] }];
		const r = (extra) => ({ agent: "worker", task: "t", usage, stderr: "", exitCode: -1, messages: [], ...extra });
		const base = {};
		const render = (details, expanded) =>
			tool.renderResult({ content: [{ type: "text", text: "x" }], details }, { expanded }, theme, {}).render(120).join("\n");
		for (const expanded of [false, true]) {
			const single = (extra) => render({ ...base, mode: "single", results: [r(extra)] }, expanded);
			for (const status of ["queued", "running"]) {
				const empty = single({ status });
				assert.match(empty, /⏳/);
				assert.match(empty, new RegExp(`\\(${status}\\.\\.\\.\\)`));
				assert.doesNotMatch(empty, /✓|✗|⊘|\(no output\)|\$0\.01/);
				const partial = single({ status, messages: msg("partial") });
				assert.match(partial, /⏳/);
				assert.match(partial, new RegExp(status));
				assert.match(partial, /partial/);
				assert.doesNotMatch(partial, /✓|\$0\.01/);
			}
			const aborted = single({ status: "aborted", exitCode: 1, stopReason: "aborted", errorMessage: "Subagent was aborted" });
			assert.match(aborted, /⊘/);
			assert.doesNotMatch(aborted, /✓|✗/);
			const failed = single({ status: "failed", exitCode: 3, messages: msg("oops") });
			assert.match(failed, /✗/);
			assert.doesNotMatch(failed, /✓|⊘/);
			assert.match(single({ status: "completed", exitCode: 0, messages: msg("ok") }), /✓/);

			const out = render(
				{
					...base,
					mode: "parallel",
					results: [
						r({ status: "completed", exitCode: 0, messages: msg("fine") }),
						r({ status: "failed", exitCode: 3, messages: msg("bad") }),
						r({ status: "aborted", exitCode: 1, messages: [] }),
						r({ status: "running", messages: msg("halfway") }),
						r({ status: "queued" }),
						r({ status: "queued" }),
					],
				},
				expanded,
			);
			assert.match(out, /3\/6 done, 1 running, 2 queued/);
			assert.match(out, /⊘/);
			assert.match(out, /halfway/);
			assert.match(out, /running/);
			assert.equal((out.match(/\(queued\.\.\.\)/g) ?? []).length, 2);
		}
		const finished = render(
			{ ...base, mode: "parallel", results: [r({ status: "completed", exitCode: 0, messages: msg("a") }), r({ status: "aborted", exitCode: 1 })] },
			true,
		);
		assert.match(finished, /⊘/);
	});
});

// ---------------------------------------------------------------------------
// Fix 1: all assistant text parts, in order, without separators
// ---------------------------------------------------------------------------
test("single and parallel model-facing output concatenates every text part in order", async () => {
	await withExtension(undefined, async ({ call }) => {
		const single = await call({ agent: "worker", task: "multipart" });
		assert.equal(text(single), "alphaé-beta");
		assert.equal(single.details.results[0].finalOutput, "alphaé-beta");
		const par = await call({ tasks: [P(1, "multipart"), P(2)] });
		assert.match(text(par), /### \[worker\] completed\n\nalphaé-beta/);
	});
});

test("combined text parts over the cap are truncated once with a UTF-8-safe notice", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ agent: "worker", task: "multibig" });
		const result = r.details.results[0];
		assert.equal(result.output.finalOutputTruncated, true);
		assert.ok(Buffer.byteLength(result.finalOutput) <= 64 * 1024);
		assert.match(result.finalOutput, /^a{1000}/);
		assert.match(result.finalOutput, /Output truncated/);
		assert.doesNotMatch(result.finalOutput, /�/);
		assert.ok(Buffer.byteLength(text(r)) <= 16 * 1024 + 200);
	});
});

test("an explicitly empty final text part yields no output rather than an earlier part", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ agent: "worker", task: "emptytext" });
		assert.equal(r.details.results[0].finalOutput, "");
		assert.equal(text(r), "(no output)");
	});
});

test("legacy results without a retained final answer render all text parts in expanded views", async () => {
	await withExtension(undefined, async ({ tool }) => {
		const theme = { fg: (_c, t) => t, bold: (t) => t };
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };
		const parts = (...ts) => [{ role: "assistant", content: ts.map((t) => ({ type: "text", text: t })) }];
		const legacy = (messages) => ({ agent: "worker", task: "t", exitCode: 0, status: "completed", usage, stderr: "", messages });
		const render = (mode, messages) => tool.renderResult({ content: [{ type: "text", text: "x" }], details: { mode, results: [legacy(messages)] } }, { expanded: true }, theme, {}).render(120).join("\n");
		for (const mode of ["single", "parallel"]) {
			assert.match(render(mode, parts("alpha", "beta")), /alphabeta/);
			const big = render(mode, parts("a".repeat(40000), "é".repeat(20000)));
			assert.match(big, /Output\s+truncated/);
			assert.ok(Buffer.byteLength(big.replace(/\s/g, "")) < 70 * 1024);
		}
	});
});

// ---------------------------------------------------------------------------
// Fix 3: a malformed agent file must not block valid agents
// ---------------------------------------------------------------------------
test("a malformed agent definition is skipped and valid workers still dispatch", async () => {
	await withExtension(undefined, async ({ e, call }) => {
		fs.writeFileSync(path.join(e.agentDir, "agents", "broken.md"), "---\nname: broken\ndescription: [unterminated\ntools: read\n  bad: : :\n---\nbody\n");
		const r = await call({ agent: "worker", task: "hello" });
		assert.equal(r.isError, undefined);
		assert.equal(r.details.results[0].status, "completed");
		assert.match(text(r), /task=hello/);
		const broken = await call({ agent: "broken", task: "x" });
		assert.equal(broken.isError, true);
		assert.match(broken.details.results[0].stderr, /Unknown agent: "broken"/);
		assert.equal(events_count(e), 1);
	});
});
const events_count = (e) => fs.readFileSync(e.log, "utf8").split("\n").filter((l) => l.startsWith("S")).length;

// ---------------------------------------------------------------------------
// Fix 2: top-level AgentToolResult.usage (full Pi Usage), summed over all work
// ---------------------------------------------------------------------------
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
// One full-usage child: assistant U(1)+reasoning/1h, toolResult U(1), mirrored tool_result_end (ignored), final assistant U(2).
const USAGE_CHILD = { input: 40, output: 20, cacheRead: 12, cacheWrite: 8, cacheWrite1h: 1, reasoning: 2, totalTokens: 80, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25, total: 3.75 } };
const PLAIN_CHILD = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("a single subagent returns full Pi usage at the top level and keeps the legacy per-result shape", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ agent: "worker", task: "usage" });
		assert.deepEqual(r.usage, USAGE_CHILD);
		assert.deepEqual(r.details.results[0].fullUsage, USAGE_CHILD);
		assert.deepEqual(r.details.results[0].usage, { input: 40, output: 20, cacheRead: 12, cacheWrite: 8, cost: 3.75, contextTokens: 40, turns: 2 });
	});
});

test("optional usage subsets are absent when no provider reported them", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ agent: "worker", task: "plain" });
		assert.deepEqual(r.usage, PLAIN_CHILD);
		assert.equal("reasoning" in r.usage, false);
		assert.equal("cacheWrite1h" in r.usage, false);
	});
});

test("a mixed parallel batch sums successful and failed children", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ tasks: [P(1, "usage"), P(2, "plain"), P(3, "usage fail")] });
		assert.deepEqual(r.details.results.map((x) => x.status), ["completed", "completed", "failed"]);
		assert.deepEqual(r.usage, {
			input: 81, output: 41, cacheRead: 24, cacheWrite: 16, cacheWrite1h: 2, reasoning: 4, totalTokens: 162,
			cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 0.5, total: 7.5 },
		});
	});
});

test("work done before an abort is still reported", async () => {
	await withExtension(undefined, async ({ call }) => {
		const ac = new AbortController();
		let seen = false;
		const p = call({ agent: "worker", task: "usage-early sleep:10000" }, ac.signal, (u) => { if (u.details.results[0].usage.turns > 0) seen = true; });
		await until(() => seen);
		ac.abort();
		const r = await p;
		assert.equal(r.details.results[0].status, "aborted");
		assert.deepEqual(r.usage, { ...ZERO, input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { input: 0.25, output: 0.5, cacheRead: 0.125, cacheWrite: 0.0625, total: 0.9375 } });
	});
});

test("usage survives history eviction", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ agent: "worker", task: "usage noisy" });
		assert.ok(r.details.results[0].output.omittedMessages > 0);
		assert.equal(r.usage.input, 140);
		assert.equal(r.usage.output, 120);
		assert.equal(r.usage.totalTokens, 80);
		assert.equal(r.usage.cost.total, 3.75);
	});
});

test("tasks that fail before starting contribute zero usage but still return a usage object", async () => {
	await withExtension(undefined, async ({ call }) => {
		const r = await call({ tasks: [{ agent: "ghost", task: "x" }] });
		assert.deepEqual(r.usage, ZERO);
	});
});

// ---------------------------------------------------------------------------
// Fix 4: failure diagnostics render in every view (errorMessage → stderr → final)
// ---------------------------------------------------------------------------
test("failed results show diagnostics in single and parallel, collapsed and expanded", async () => {
	await withExtension(undefined, async ({ tool }) => {
		const theme = { fg: (_c, t) => t, bold: (t) => t };
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
		const msg = (t) => [{ role: "assistant", content: [{ type: "text", text: t }] }];
		const r = (extra) => ({ agent: "worker", task: "t", usage, exitCode: 3, status: "failed", messages: [], stderr: "", ...extra });
		const render = (mode, result, expanded) => tool.renderResult({ content: [{ type: "text", text: "x" }], details: { mode, results: [result] } }, { expanded }, theme, {}).render(200).join("\n");
		for (const mode of ["single", "parallel"]) for (const expanded of [false, true]) {
			const label = `${mode} expanded=${expanded}`;
			const stderrOnly = render(mode, r({ stderr: "child crashed: EBADF" }), expanded);
			assert.match(stderrOnly, /child crashed: EBADF/, label);
			assert.doesNotMatch(stderrOnly, /\(no output\)/, label);
			const provider = render(mode, r({ stopReason: "error", errorMessage: "429 rate limited", stderr: "process note", messages: msg("stale answer") }), expanded);
			assert.match(provider, /429 rate limited/, label);
			assert.doesNotMatch(provider, /process note/, label);
			const note = render(mode, r({ stderr: "Subagent terminated by signal SIGSEGV", messages: msg("stale answer") }), expanded);
			assert.match(note, /Subagent terminated by signal SIGSEGV/, label);
			const huge = render(mode, r({ stderr: "z".repeat(60000), output: { stderrOmittedBytes: 5 } }), expanded);
			assert.match(huge, /Output\s+truncated/, label);
			assert.ok(Buffer.byteLength(huge.replace(/\s/g, "")) < 20 * 1024, label);
			const ok = render(mode, r({ exitCode: 0, status: "completed", stderr: "harmless warning", messages: msg("fine") }), expanded);
			assert.doesNotMatch(ok, /harmless warning/, label);
		}
	});
});

// ---------------------------------------------------------------------------
// Process-tree cancellation with real processes (no model calls)
// ---------------------------------------------------------------------------
import { spawn as realSpawn } from "node:child_process";

test("cancelling a detached child that ignores SIGTERM removes its grandchild too", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-tree-"));
	const pidFile = path.join(root, "pids");
	const script = path.join(root, "child.mjs");
	// Stands in for pi: ignores SIGTERM and starts a grandchild that also ignores it and holds the output pipes.
	fs.writeFileSync(script, `
import { spawn } from "node:child_process";
import fs from "node:fs";
process.on("SIGTERM", () => {});
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "inherit" });
fs.writeFileSync(process.argv[2], process.pid + " " + grandchild.pid);
setInterval(() => {}, 1000);
`);
	const runner = createChildRunner({ capacity: 1, spawn: realSpawn, killGraceMs: 300 });
	const controller = new AbortController();
	const run = runner.run({
		signal: controller.signal,
		prepare: () => ({ command: process.execPath, args: [script, pidFile], cwd: root, detached: true }),
	});
	let pids = [];
	try {
		await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").split(" ").length === 2);
		pids = fs.readFileSync(pidFile, "utf8").split(" ").map(Number);
		await sleep(300); // let the grandchild install its SIGTERM handler
		assert.ok(pids.every(pidAlive));
		const started = Date.now();
		controller.abort();
		assert.equal((await run).status, "aborted");
		assert.ok(Date.now() - started >= 250, "the TERM-ignoring tree survives until the grace period ends");
		await until(() => pids.every((pid) => !pidAlive(pid)), 2000);
	} finally {
		for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch {}
		fs.rmSync(root, { recursive: true, force: true });
	}
});
