#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.resolve(process.argv[2] ?? path.join(os.homedir(), ".pi/agent/extensions/subagent"));
const backupRoot = path.resolve(process.env.PI_SUBAGENT_BACKUP_DIR ?? path.join(os.homedir(), ".pi/agent/backups"));
const files = ["index.ts", "agents.ts", "lifecycle.mjs", "output.mjs", "subagent.test.mjs", "output.test.mjs", "README.md", "LICENSE"];

function statIfPresent(file) {
	try { return fs.lstatSync(file); }
	catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
function checkRegular(file, required = false) {
	const stat = statIfPresent(file);
	if (!stat && !required) return false;
	if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file, not a symlink: ${file}`);
	return true;
}

let stage;
try {
	if (process.env.PI_SUBAGENT_BACKUP_DIR !== undefined && !process.env.PI_SUBAGENT_BACKUP_DIR.trim()) {
		throw new Error("Backup directory override must not be empty");
	}
	if ([path.dirname(destination), path.join(os.homedir(), ".pi/agent/extensions")].includes(backupRoot)) {
		throw new Error("Backup directory must not be an extension discovery root");
	}
	if (destination === source) throw new Error("The install destination must differ from the source directory");
	const directory = statIfPresent(destination);
	if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) {
		throw new Error(`Install destination must be a directory, not a symlink: ${destination}`);
	}
	// Validate every owned path before modifying the installation.
	const existing = files.filter((file) => {
		checkRegular(path.join(source, file), true);
		return checkRegular(path.join(destination, file));
	});
	fs.mkdirSync(destination, { recursive: true });
	// Pi scans immediate children of extension roots. Stage one level deeper so
	// an interrupted install never leaves a second discoverable index.ts.
	stage = fs.mkdtempSync(path.join(destination, ".pi-subagent-install-"));
	for (const file of files) {
		fs.copyFileSync(path.join(source, file), path.join(stage, file));
		fs.chmodSync(path.join(stage, file), 0o644);
	}
	if (existing.length) {
		fs.mkdirSync(backupRoot, { recursive: true });
		const backup = fs.mkdtempSync(path.join(backupRoot, "subagent-"));
		for (const file of existing) fs.copyFileSync(path.join(destination, file), path.join(backup, file));
		console.log(`Backup: ${backup}`);
	}
	fs.mkdirSync(destination, { recursive: true });
	// Rename staged copies, rather than writing through a possible destination link.
	// Each file replacement is atomic; the installation as a whole is not transactional.
	for (const file of files) fs.renameSync(path.join(stage, file), path.join(destination, file));
	console.log(`Installed regular-file copies in ${destination}. Run /reload while idle or restart Pi.`);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
} finally {
	if (stage) fs.rmSync(stage, { recursive: true, force: true });
}
