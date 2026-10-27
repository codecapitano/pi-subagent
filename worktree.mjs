import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { KILL_GRACE_MS } from "./lifecycle.mjs";
import { truncateUtf8 } from "./output.mjs";

const STDOUT_CHARS = 1024 * 1024;
const STDERR_CHARS = 16 * 1024;
const DIAGNOSTIC_LINES = 8;
const DIAGNOSTIC_BYTES = 2048;

/**
 * Runs a process in its own group and settles only after it has closed. An abort sends SIGTERM to
 * the group, then SIGKILL after `killGraceMs`, so shutdown can wait for it. Never rejects. Keeps the
 * start of stdout and the end of stderr. `aborted` is true when the signal fired before the close.
 */
function spawnCollect(file, args, { cwd, signal, shell = false, killGraceMs = KILL_GRACE_MS }) {
	return new Promise((resolve) => {
		const failed = (stderr, aborted = false) => resolve({ code: 1, signal: null, stdout: "", stderr, aborted });
		if (signal?.aborted) return failed("aborted", true);
		let child;
		try {
			child = spawn(file, args, { cwd, shell, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			return failed(error.message);
		}
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { if (stdout.length < STDOUT_CHARS) stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-STDERR_CHARS); });
		let timer;
		let aborted = false;
		const kill = (sig) => {
			try { process.kill(-child.pid, sig); }
			catch { try { child.kill(sig); } catch { /* already gone */ } }
		};
		const onAbort = () => {
			aborted = true;
			kill("SIGTERM");
			timer = setTimeout(() => kill("SIGKILL"), killGraceMs);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		let settled = false;
		const finish = (code, sig, error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ code: typeof code === "number" ? code : 1, signal: sig ?? null, stdout, stderr: stderr || error || (aborted ? "aborted" : ""), aborted });
		};
		child.on("error", (error) => finish(1, null, error.message));
		child.on("close", (code, sig) => finish(code, sig));
	});
}

/** Runs git without a shell. A failure is a non-zero `code` with stderr text; an abort fails it too. */
async function git(cwd, args, signal) {
	const { code, stdout, stderr } = await spawnCollect("git", args, { cwd, signal });
	return { code, stdout, stderr };
}

/** Last few lines, bounded in bytes too: one hook error line can be arbitrarily long. */
const tail = (text) => truncateUtf8(text.trim().split("\n").slice(-DIAGNOSTIC_LINES).join("\n"), DIAGNOSTIC_BYTES, "\n[Output truncated.]");

// Concurrent `git worktree add` calls contend for repository locks, so lane creation is serialized.
let creating = Promise.resolve();
const serialized = (fn) => {
	const run = creating.then(fn);
	creating = run.catch(() => {});
	return run;
};

/** Turns a branch name into a safe directory name: unsafe characters become `-`, lower case. */
export function branchSlug(branch) {
	return branch
		.replace(/^refs\/heads\//, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

function isDirectory(dir) {
	try { return fs.statSync(dir).isDirectory(); }
	catch { return false; }
}

/**
 * Lane directory layout: `<parent>/worktrees/<repo>/<slug>` when the directory containing the
 * repository also has a `worktrees` directory, else the sibling `<parent>/<repo>-<slug>`.
 */
export function resolveLanePath(main, branch) {
	const repo = path.basename(main);
	const parent = path.dirname(main);
	const slug = branchSlug(branch);
	const workspaceWorktrees = path.join(parent, "worktrees");
	return isDirectory(workspaceWorktrees) ? path.join(workspaceWorktrees, repo, slug) : path.join(parent, `${repo}-${slug}`);
}

const quote = (value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

/**
 * Exact commands that remove a lane once its branch is merged. They run from the checkout the lane
 * branched from, because `branch -d` checks the merge against that checkout's HEAD. When the parent
 * works in a linked worktree, that is not the main worktree. `branch -d` refuses an unmerged branch.
 */
export function cleanupCommands({ checkout, path: lanePath, branch }) {
	return [`git -C ${quote(checkout)} worktree remove ${quote(lanePath)}`, `git -C ${quote(checkout)} branch -d ${quote(branch)}`];
}

/**
 * Creates a lane: a new branch and worktree at the current HEAD of the checkout containing `cwd`.
 * The main worktree is the first `git worktree list --porcelain` entry, so this also works when
 * the caller is itself inside a linked worktree. Rejects with a readable message on failure.
 */
export async function createLane({ cwd, agent, id = randomBytes(3).toString("hex") }) {
	const prefix = await git(cwd, ["rev-parse", "--show-prefix"]);
	if (prefix.code !== 0) throw new Error(`Cannot create a worktree lane: ${cwd} is not inside a git repository.`);
	const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
	const listed = await git(cwd, ["worktree", "list", "--porcelain"]);
	const main = /^worktree (.+)$/m.exec(listed.stdout)?.[1];
	if (top.code !== 0 || listed.code !== 0 || !main) throw new Error(`Cannot create a worktree lane: git worktree list failed: ${tail(listed.stderr)}`);
	const head = await git(cwd, ["rev-parse", "HEAD"]);
	if (head.code !== 0) throw new Error("Cannot create a worktree lane: the repository has no commits yet.");
	const base = head.stdout.trim();
	const parentDirty = (await git(cwd, ["status", "--porcelain"])).stdout.trim() !== "";

	// A task started in a subdirectory keeps that position inside the lane. Check it before creating anything.
	const subdirectory = prefix.stdout.trim().replace(/\/$/, "");
	if (subdirectory && (await git(cwd, ["cat-file", "-e", `${base}:${subdirectory}`])).code !== 0) {
		throw new Error(`Cannot create a worktree lane: ${subdirectory} does not exist in ${base.slice(0, 7)}; commit it first.`);
	}

	const branch = `subagent/${branchSlug(agent) || "agent"}-${id}`;
	const lanePath = resolveLanePath(main, branch);
	const added = await serialized(() => git(cwd, ["worktree", "add", "-b", branch, lanePath, base]));
	if (added.code !== 0) throw new Error(`Cannot create a worktree lane: git worktree add failed: ${tail(added.stderr)}`);

	return { main, checkout: top.stdout.trim(), path: lanePath, branch, base, cwd: path.join(lanePath, subdirectory), parentDirty };
}

/**
 * Runs the task's setup command in the lane through the shell, in its own process group.
 * Settles only after the process has closed: an abort sends SIGTERM to the group, then SIGKILL
 * after `killGraceMs`. Rejects on a non-zero exit or abort; the lane is kept either way.
 */
export async function runSetup(lane, command, signal, killGraceMs = KILL_GRACE_MS) {
	const result = await spawnCollect(command, [], { cwd: lane.cwd, signal, shell: true, killGraceMs });
	if (!result.aborted && result.code === 0 && !result.signal) return;
	const reason = result.aborted ? "aborted" : result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
	const output = tail(`${result.stderr}\n${result.stdout}`);
	throw new Error(`Worktree setup failed (${reason}); the lane was kept at ${lane.path}.${output ? `\n${output}` : ""}`);
}

/**
 * Collects the lane's final state. With `commit`, a dirty lane is committed with plain
 * `git add -A` and `git commit`, so repository hooks and signing run. If that fails, the
 * lane stays dirty and the reason is reported. An abort `signal` terminates the git
 * processes (git removes its own lock files on SIGTERM) and leaves the lane as it is.
 */
export async function finishLane(lane, { agent, task, commit, signal }) {
	const dirty = async () => (await git(lane.path, ["status", "--porcelain"], signal)).stdout.trim() !== "";
	let committed = false;
	let commitError;
	let stillDirty = await dirty();
	if (commit && stillDirty) {
		const subject = task.trim().split("\n")[0].slice(0, 72);
		const add = await git(lane.path, ["add", "-A"], signal);
		const result = add.code === 0 ? await git(lane.path, ["commit", "-m", `subagent(${agent}): ${subject}`], signal) : add;
		if (result.code === 0) committed = true;
		else commitError = tail(result.stderr || result.stdout);
		stillDirty = await dirty();
	}
	const ahead = await git(lane.path, ["rev-list", "--count", `${lane.base}..${lane.branch}`], signal);
	return {
		path: lane.path,
		branch: lane.branch,
		base: lane.base,
		commitsAhead: ahead.code === 0 ? Number(ahead.stdout.trim()) : 0,
		committed,
		dirty: stillDirty,
		parentDirty: lane.parentDirty,
		...(commitError ? { commitError } : {}),
		cleanup: cleanupCommands(lane),
	};
}

/** One-line summary of a lane's state. */
export function describeLaneState(info) {
	const commits = `${info.commitsAhead} commit${info.commitsAhead === 1 ? "" : "s"} ahead of ${info.base.slice(0, 7)}`;
	const state = info.dirty ? "uncommitted changes remain" : info.committed ? "committed by the extension" : "clean";
	return `${commits}, ${state}`;
}

/** Model-facing block: where the lane is, its state, warnings and the exact cleanup commands. */
export function formatLane(info) {
	const lines = [`Worktree: ${info.path}`, `Branch: ${info.branch} (${describeLaneState(info)})`];
	if (info.commitError) lines.push(`Commit failed; the lane was left dirty:\n${info.commitError}`);
	if (info.parentDirty) lines.push("Warning: the parent checkout had uncommitted changes. The lane started from HEAD and does not contain them.");
	lines.push("After the branch is merged, or after this lane is inspected, remove it:", ...info.cleanup.map((command) => `  ${command}`));
	return lines.join("\n");
}
