import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const agentsDir = path.join(root, "agents");
const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));

test("starter agents are present", () => {
	assert.deepEqual(
		agentFiles.sort(),
		["advisor.md", "explorer.md", "implementer.md", "reviewer.md", "scout.md", "transformer.md", "verifier.md"],
	);
});

for (const file of agentFiles) {
	test(`${file} has valid frontmatter, a tool allowlist and no pinned model`, () => {
		const text = fs.readFileSync(path.join(agentsDir, file), "utf8");
		const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(text);
		assert.ok(match, "frontmatter block");
		const front = match[1];
		assert.equal(/^name: (.+)$/m.exec(front)?.[1], file.replace(/\.md$/, ""));
		assert.match(front, /^description: .+$/m);
		assert.match(front, /^tools: \[[^\]]+\]$/m);
		// Model IDs are provider-specific; starters inherit the parent's model.
		assert.doesNotMatch(front, /^model:/m);
		assert.ok(match[2].trim().length > 0, "prompt body");
	});
}

test("implementer can consult without general delegation and advisor stays read-only", () => {
	const implementer = fs.readFileSync(path.join(agentsDir, "implementer.md"), "utf8");
	assert.match(implementer, /^tools: \[read, edit, write, bash, grep, find, ls, consult_advisor\]$/m);
	const advisor = fs.readFileSync(path.join(agentsDir, "advisor.md"), "utf8");
	assert.match(advisor, /^tools: \[read, grep, find, ls\]$/m);
});

// Everything published must be free of machine-specific or private details.
const FORBIDDEN = [
	/\/Users\//,
	/\/home\/[a-z]/i,
	/marcoschafer|schaefer|schäfer/i,
	/grafana/i,
	/openai-codex|luna|\bsol:/i,
	/[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9.-]+\.[a-z]{2,}/i,
	/gh[pousr]_[A-Za-z0-9]{20,}/,
	/\bmcp__(?!chrome_devtools__|figma__)/,
];
function publishedFiles(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === ".git" || entry.name === "node_modules") return [];
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? publishedFiles(full) : [full];
	});
}

test("no published file contains machine-specific or private details", () => {
	const hits = [];
	for (const file of publishedFiles(root)) {
		if (file === fileURLToPath(import.meta.url)) continue; // holds the patterns themselves
		const text = fs.readFileSync(file, "utf8");
		for (const pattern of FORBIDDEN) {
			if (pattern.test(text)) hits.push(`${path.relative(root, file)}: ${pattern}`);
		}
	}
	assert.deepEqual(hits, []);
});

test("optional agents are valid and do not pin a model", () => {
	const dir = path.join(agentsDir, "optional");
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
	assert.deepEqual(files, ["design-reviewer.md"]);
	for (const file of files) {
		const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(fs.readFileSync(path.join(dir, file), "utf8"));
		assert.ok(match, `${file} frontmatter`);
		assert.equal(/^name: (.+)$/m.exec(match[1])?.[1], file.replace(/\.md$/, ""));
		assert.match(match[1], /^tools: \[[^\]]+\]$/m);
		assert.doesNotMatch(match[1], /^model:/m);
	}
});
