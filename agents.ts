/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	model?: string;
	systemPrompt: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	/** Role files that were ignored, with the reason. */
	skipped: { file: string; reason: string }[];
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Invalid or empty values reject that agent definition. This
 * fails closed instead of silently giving a child Pi process its default tools.
 */
function parseToolList(value: unknown): string[] | null {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
	if (!raw || !raw.every((tool) => typeof tool === "string")) return null;
	const tools = raw.map((tool) => tool.trim()).filter(Boolean);
	return tools.length > 0 ? tools : null;
}

/** A role that cannot edit files or delegate. Bash stays allowed; read-only use is a prompt rule. */
export function isReadOnlyAgent(agent: AgentConfig): boolean {
	return !agent.tools.some((tool) => tool === "edit" || tool === "write" || tool === "subagent");
}

/** Reads user-level roles from the agent directory. A malformed file is skipped and reported, never fatal. */
export function discoverAgents(): AgentDiscoveryResult {
	const dir = path.join(getAgentDir(), "agents");
	const result: AgentDiscoveryResult = { agents: [], skipped: [] };
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return result;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || !(entry.isFile() || entry.isSymbolicLink())) continue;
		const skip = (reason: string) => result.skipped.push({ file: entry.name, reason });

		let parsed: ReturnType<typeof parseFrontmatter<AgentFrontmatter>>;
		try {
			parsed = parseFrontmatter<AgentFrontmatter>(fs.readFileSync(path.join(dir, entry.name), "utf-8"));
		} catch {
			skip("invalid frontmatter");
			continue;
		}
		const { frontmatter, body } = parsed;
		const tools = parseToolList(frontmatter.tools);
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string" || !tools) {
			skip("missing name, description or tools");
			continue;
		}
		result.agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
		});
	}
	return result;
}

/** Roster text for the tool description, bounded so a large directory cannot bloat the prompt. */
export function describeAgents({ agents, skipped }: AgentDiscoveryResult, maxItems = 20, maxDescription = 120): string {
	const clip = (text: string) => {
		const oneLine = text.replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
		return oneLine.length > maxDescription ? `${oneLine.slice(0, maxDescription - 3)}...` : oneLine;
	};
	const lines = agents.slice(0, maxItems).map((a) => `${a.name}: ${clip(a.description)}`);
	const more = agents.length - lines.length;
	const roster = lines.length === 0 ? "No user-level agents are defined yet." : `Available agents: ${lines.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
	const warning = skipped.length === 0 ? "" : ` Skipped agent files: ${skipped.slice(0, 5).map((s) => `${s.file} (${s.reason})`).join(", ")}.`;
	return roster + warning;
}
