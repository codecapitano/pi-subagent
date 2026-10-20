import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const source = path.dirname(fileURLToPath(import.meta.url));
const files = ["index.ts", "agents.ts", "lifecycle.mjs", "output.mjs", "subagent.test.mjs", "output.test.mjs", "README.md", "LICENSE"];
function environment(fn) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-install-test-"));
	const destination = path.join(root, "installed");
	const backups = path.join(root, "backups");
	const run = (extraArgs = [], extraEnv = {}) => spawnSync(process.execPath, [...extraArgs, path.join(source, "scripts/install.mjs"), destination], {
		encoding: "utf8", env: { ...process.env, PI_SUBAGENT_BACKUP_DIR: backups, ...extraEnv },
	});
	try { fn({ root, destination, backups, run }); }
	finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("reinstallation backs up owned files and preserves unrelated files", () => {
	environment(({ destination, backups, run }) => {
		assert.equal(run().status, 0);
		fs.writeFileSync(path.join(destination, 'index.ts'), 'old version');
		fs.writeFileSync(path.join(destination, 'notes.txt'), 'keep me');
		const result = run();
		assert.equal(result.status, 0, result.stderr);
		assert.equal(fs.readFileSync(path.join(destination, 'notes.txt'), 'utf8'), 'keep me');
		assert.ok(fs.existsSync(backups), 'existing files must be backed up');
		const snapshots = fs.readdirSync(backups);
		assert.equal(snapshots.length, 1);
		assert.equal(fs.readFileSync(path.join(backups, snapshots[0], 'index.ts'), 'utf8'), 'old version');
		assert.deepEqual(fs.readFileSync(path.join(destination, 'index.ts')), fs.readFileSync(path.join(source, 'index.ts')));
	});
});

for (const target of ['directory', 'file']) {
	test(`installer refuses a symlink ${target} without changing its target`, () => {
		environment(({ root, destination, run }) => {
			const outside = path.join(root, 'outside');
			fs.mkdirSync(outside);
			fs.writeFileSync(path.join(outside, 'index.ts'), 'untouched');
			if (target === 'directory') fs.symlinkSync(outside, destination, 'dir');
			else { fs.mkdirSync(destination); fs.symlinkSync(path.join(outside, 'index.ts'), path.join(destination, 'index.ts')); }
			const result = run();
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /symlink/);
			assert.equal(fs.readFileSync(path.join(outside, 'index.ts'), 'utf8'), 'untouched');
		});
	});
}

test("interrupted staging cannot create an extra discoverable extension", () => {
	environment(({ root, destination, run }) => {
		assert.equal(run().status, 0);
		const fault = path.join(root, 'interrupt.mjs');
		fs.writeFileSync(fault, 'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; fs.renameSync = () => process.exit(99); syncBuiltinESMExports();');
		const interrupted = run(['--import', fault]);
		assert.equal(interrupted.status, 99, interrupted.stderr);
		const discoverable = fs.readdirSync(root).filter((name) => fs.existsSync(path.join(root, name, 'index.ts')));
		assert.deepEqual(discoverable, [path.basename(destination)]);
	});
});

for (const override of ['', 'parent']) {
	test(`unsafe backup override ${override || 'empty'} is rejected before installation`, () => {
		environment(({ root, destination, run }) => {
			const result = run([], { PI_SUBAGENT_BACKUP_DIR: override === 'parent' ? root : override });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /backup/i);
			assert.ok(!fs.existsSync(path.join(destination, 'index.ts')));
		});
	});
}

test("installer creates standalone regular-file copies", () => {
	environment(({ destination, run }) => {
		const result = run();
		assert.equal(result.status, 0, result.stderr);
		for (const file of files) {
			const installed = path.join(destination, file);
			assert.ok(fs.existsSync(installed), `${file} must be installed`);
			assert.ok(fs.lstatSync(installed).isFile());
			assert.ok(!fs.lstatSync(installed).isSymbolicLink());
			assert.deepEqual(fs.readFileSync(installed), fs.readFileSync(path.join(source, file)));
		}
	});
});
