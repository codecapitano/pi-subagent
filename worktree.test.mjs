import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { branchSlug, cleanupCommands, createLane, finishLane, formatLane, resolveLanePath, runSetup } from "./worktree.mjs";

// Isolate from the developer's git configuration (signing, hooks, templates).
Object.assign(process.env, {
	GIT_CONFIG_GLOBAL: os.devNull,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@users.noreply.github.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@users.noreply.github.com",
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Runs `fn` with a temporary repository at `<root>/repo`. */
async function withRepo(fn, { name = "repo", commit = true } = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "subagent-worktree-test-")));
	const repo = path.join(root, name);
	fs.mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	if (commit) {
		fs.mkdirSync(path.join(repo, "sub"));
		fs.writeFileSync(path.join(repo, "sub", "file.txt"), "base\n");
		fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "base");
	}
	try { await fn({ root, repo }); }
	finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("a lane is a new branch and worktree at HEAD in the sibling layout", async () => {
	await withRepo(async ({ root, repo }) => {
		const lane = await createLane({ cwd: repo, agent: "implementer", id: "abc123" });
		assert.equal(lane.branch, "subagent/implementer-abc123");
		assert.equal(lane.path, path.join(root, "repo-subagent-implementer-abc123"));
		assert.equal(lane.cwd, lane.path);
		assert.equal(lane.main, repo);
		assert.equal(lane.base, git(repo, "rev-parse", "HEAD"));
		assert.equal(git(lane.path, "rev-parse", "--abbrev-ref", "HEAD"), lane.branch);
		assert.equal(git(lane.path, "rev-parse", "HEAD"), lane.base);
		assert.equal(lane.parentDirty, false);
	});
});

test("a workspace worktrees directory selects the nested layout", async () => {
	await withRepo(async ({ root, repo }) => {
		fs.mkdirSync(path.join(root, "worktrees"));
		const lane = await createLane({ cwd: repo, agent: "worker", id: "abc123" });
		assert.equal(lane.path, path.join(root, "worktrees", "repo", "subagent-worker-abc123"));
		assert.ok(fs.existsSync(path.join(lane.path, "sub", "file.txt")));
		assert.equal(resolveLanePath(repo, "Feature/X Y"), path.join(root, "worktrees", "repo", branchSlug("Feature/X Y")));
	});
});

test("the main worktree is found when the caller is itself in a linked worktree", async () => {
	await withRepo(async ({ root, repo }) => {
		const linked = path.join(root, "linked");
		git(repo, "worktree", "add", "-q", "-b", "feature", linked);
		const lane = await createLane({ cwd: linked, agent: "worker", id: "abc123" });
		assert.equal(lane.main, repo);
		assert.equal(lane.checkout, linked);
		assert.equal(lane.path, path.join(root, "repo-subagent-worker-abc123"));
	});
});

test("cleanup works when the parent merges into a linked worktree", async () => {
	await withRepo(async ({ root, repo }) => {
		const linked = path.join(root, "linked");
		git(repo, "worktree", "add", "-q", "-b", "feature", linked);
		const lane = await createLane({ cwd: linked, agent: "worker", id: "abc123" });
		fs.writeFileSync(path.join(lane.path, "new.txt"), "x\n");
		const info = await finishLane(lane, { agent: "worker", task: "t", commit: true });
		// The main worktree's HEAD never contains the lane; only the linked checkout does.
		git(linked, "merge", "-q", "--no-ff", "-m", "merge lane", lane.branch);
		for (const command of info.cleanup) assert.equal(spawnSync("sh", ["-c", command]).status, 0, command);
		assert.ok(!fs.existsSync(lane.path));
		assert.equal(git(repo, "branch", "--list", lane.branch), "");
		assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 2);
	});
});

test("a task started in a subdirectory keeps that position in the lane", async () => {
	await withRepo(async ({ repo }) => {
		const lane = await createLane({ cwd: path.join(repo, "sub"), agent: "worker", id: "abc123" });
		assert.equal(lane.cwd, path.join(lane.path, "sub"));
	});
});

test("a subdirectory missing from HEAD fails before anything is created", async () => {
	await withRepo(async ({ root, repo }) => {
		fs.mkdirSync(path.join(repo, "untracked"));
		await assert.rejects(createLane({ cwd: path.join(repo, "untracked"), agent: "worker", id: "abc123" }), /untracked does not exist/);
		assert.deepEqual(fs.readdirSync(root), ["repo"]);
		assert.equal(git(repo, "branch", "--list", "subagent/*"), "");
	});
});

test("a directory that is not a repository fails cleanly", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "subagent-not-a-repo-")));
	try {
		await assert.rejects(createLane({ cwd: dir, agent: "worker" }), /not inside a git repository/);
		assert.deepEqual(fs.readdirSync(dir), []);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a repository without commits fails cleanly", async () => {
	await withRepo(async ({ repo }) => {
		await assert.rejects(createLane({ cwd: repo, agent: "worker" }), /no commits/);
	}, { commit: false });
});

test("an existing branch fails cleanly and creates no worktree", async () => {
	await withRepo(async ({ root, repo }) => {
		git(repo, "branch", "subagent/worker-abc123");
		await assert.rejects(createLane({ cwd: repo, agent: "worker", id: "abc123" }), /already exists/);
		assert.deepEqual(fs.readdirSync(root), ["repo"]);
		assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
	});
});

test("parallel creation does not collide", async () => {
	await withRepo(async ({ repo }) => {
		const lanes = await Promise.all(Array.from({ length: 6 }, () => createLane({ cwd: repo, agent: "worker" })));
		assert.equal(new Set(lanes.map((lane) => lane.branch)).size, 6);
		assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 7);
	});
});

test("uncommitted changes in the parent are flagged and absent from the lane", async () => {
	await withRepo(async ({ repo }) => {
		fs.writeFileSync(path.join(repo, "sub", "file.txt"), "changed\n");
		const lane = await createLane({ cwd: repo, agent: "worker", id: "abc123" });
		assert.equal(lane.parentDirty, true);
		assert.equal(fs.readFileSync(path.join(lane.cwd, "sub", "file.txt"), "utf8"), "base\n");
		const info = await finishLane(lane, { agent: "worker", task: "t", commit: true });
		assert.equal(info.parentDirty, true);
		assert.match(formatLane(info), /parent checkout had uncommitted changes/);
	});
});

test("setup runs in the lane; a failing setup reports its output and keeps the lane", async () => {
	await withRepo(async ({ repo }) => {
		const lane = await createLane({ cwd: path.join(repo, "sub"), agent: "worker", id: "abc123" });
		await runSetup(lane, "pwd > setup-ran.txt", undefined);
		assert.equal(fs.readFileSync(path.join(lane.cwd, "setup-ran.txt"), "utf8").trim(), lane.cwd);
		await assert.rejects(runSetup(lane, "echo broken >&2; exit 4", undefined), (error) => {
			assert.match(error.message, /Worktree setup failed \(exit 4\)/);
			assert.match(error.message, /broken/);
			assert.ok(error.message.includes(lane.path));
			return true;
		});
		assert.ok(fs.existsSync(lane.path));
	});
});

test("an aborted setup is reported as aborted only after its process group is gone", async () => {
	await withRepo(async ({ repo }) => {
		const lane = await createLane({ cwd: repo, agent: "worker", id: "abc123" });
		const controller = new AbortController();
		// Ignoring SIGTERM, and passing that on to `sleep`, forces the SIGKILL escalation.
		const pending = runSetup(lane, "trap '' TERM; echo $$ > pid.txt; sleep 30", controller.signal, 100);
		while (!fs.existsSync(path.join(lane.path, "pid.txt")) || !fs.readFileSync(path.join(lane.path, "pid.txt"), "utf8").trim()) await new Promise((r) => setTimeout(r, 10));
		const pid = Number(fs.readFileSync(path.join(lane.path, "pid.txt"), "utf8"));
		controller.abort();
		await assert.rejects(pending, /Worktree setup failed \(aborted\)/);
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		await assert.rejects(runSetup(lane, "true", controller.signal, 100), /aborted/);
	});
});

test("a dirty lane is committed by the extension and reported", async () => {
	await withRepo(async ({ repo }) => {
		const lane = await createLane({ cwd: repo, agent: "implementer", id: "abc123" });
		fs.writeFileSync(path.join(lane.path, "new.txt"), "new\n");
		fs.writeFileSync(path.join(lane.path, "sub", "file.txt"), "edited\n");
		const info = await finishLane(lane, { agent: "implementer", task: "Add new.txt\nsecond line", commit: true });
		assert.equal(info.committed, true);
		assert.equal(info.dirty, false);
		assert.equal(info.commitsAhead, 1);
		assert.equal(info.base, lane.base);
		assert.equal(git(lane.path, "log", "-1", "--format=%s"), "subagent(implementer): Add new.txt");
		assert.equal(git(lane.path, "show", "--name-only", "--format=", "HEAD").split("\n").sort().join(","), "new.txt,sub/file.txt");
	});
});

test("a clean lane and a lane the child committed itself are reported without a second commit", async () => {
	await withRepo(async ({ repo }) => {
		const clean = await createLane({ cwd: repo, agent: "worker", id: "aaa111" });
		assert.deepEqual(
			(({ committed, dirty, commitsAhead }) => ({ committed, dirty, commitsAhead }))(await finishLane(clean, { agent: "worker", task: "t", commit: true })),
			{ committed: false, dirty: false, commitsAhead: 0 },
		);
		const own = await createLane({ cwd: repo, agent: "worker", id: "bbb222" });
		fs.writeFileSync(path.join(own.path, "own.txt"), "x\n");
		git(own.path, "add", "-A");
		git(own.path, "commit", "-q", "-m", "child commit");
		const info = await finishLane(own, { agent: "worker", task: "t", commit: true });
		assert.deepEqual({ committed: info.committed, dirty: info.dirty, commitsAhead: info.commitsAhead }, { committed: false, dirty: false, commitsAhead: 1 });
	});
});

test("a lane is left dirty when the caller does not ask for a commit", async () => {
	await withRepo(async ({ repo }) => {
		const lane = await createLane({ cwd: repo, agent: "worker", id: "abc123" });
		fs.writeFileSync(path.join(lane.path, "partial.txt"), "x\n");
		const info = await finishLane(lane, { agent: "worker", task: "t", commit: false });
		assert.deepEqual({ committed: info.committed, dirty: info.dirty, commitsAhead: info.commitsAhead }, { committed: false, dirty: true, commitsAhead: 0 });
		assert.match(formatLane(info), /uncommitted changes remain/);
	});
});

test("a failing commit hook is honored: the lane stays dirty and the reason is reported", async () => {
	await withRepo(async ({ repo }) => {
		const lane = await createLane({ cwd: repo, agent: "worker", id: "abc123" });
		const hooks = path.join(git(lane.path, "rev-parse", "--git-common-dir"), "hooks");
		fs.mkdirSync(hooks, { recursive: true });
		fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n", { mode: 0o755 });
		fs.writeFileSync(path.join(lane.path, "new.txt"), "x\n");
		const info = await finishLane(lane, { agent: "worker", task: "t", commit: true });
		assert.equal(info.committed, false);
		assert.equal(info.dirty, true);
		assert.equal(info.commitsAhead, 0);
		assert.match(info.commitError, /lint failed/);
		assert.match(formatLane(info), /Commit failed; the lane was left dirty:\nlint failed/);
	});
});

test("the printed cleanup commands remove the lane and its branch once merged", async () => {
	await withRepo(async ({ root, repo }) => {
		// Spaces in the path must survive the printed commands.
		const spaced = path.join(root, "my repo");
		fs.renameSync(repo, spaced);
		git(spaced, "worktree", "repair");
		const lane = await createLane({ cwd: spaced, agent: "worker", id: "abc123" });
		fs.writeFileSync(path.join(lane.path, "new.txt"), "x\n");
		// Ignored files, such as installed dependencies, must not block removal.
		fs.mkdirSync(path.join(lane.path, "node_modules"));
		fs.writeFileSync(path.join(lane.path, "node_modules", "dep.js"), "x\n");
		const info = await finishLane(lane, { agent: "worker", task: "t", commit: true });
		assert.equal(info.cleanup.length, 2);
		assert.match(formatLane(info), new RegExp(`  ${info.cleanup[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n  ${info.cleanup[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));

		// Before the merge, the branch is protected.
		const [removeLane, deleteBranch] = info.cleanup;
		assert.equal(spawnSync("sh", ["-c", removeLane]).status, 0);
		assert.ok(!fs.existsSync(lane.path));
		assert.notEqual(spawnSync("sh", ["-c", deleteBranch]).status, 0);
		assert.match(git(spaced, "branch", "--list", lane.branch), /subagent\/worker-abc123/);

		git(spaced, "merge", "-q", "--no-ff", "-m", "merge lane", lane.branch);
		assert.equal(spawnSync("sh", ["-c", deleteBranch]).status, 0);
		assert.equal(git(spaced, "branch", "--list", lane.branch), "");
		assert.equal(git(spaced, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
	});
});

test("cleanup commands quote only what needs quoting", () => {
	assert.deepEqual(cleanupCommands({ checkout: "/a/repo", path: "/a/repo-lane", branch: "subagent/w-1" }), [
		"git -C /a/repo worktree remove /a/repo-lane",
		"git -C /a/repo branch -d subagent/w-1",
	]);
	assert.equal(cleanupCommands({ checkout: "/a/it's", path: "/a/lane", branch: "b" })[0], "git -C '/a/it'\\''s' worktree remove /a/lane");
});
