/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Local policy supports two modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *
 * Chain and project-agent execution from the upstream example are retained only
 * for compatibility with stored calls and rejected before execution.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, describeAgents, discoverAgents } from "./agents.ts";
import { createChildRunner, parseConcurrency } from "./lifecycle.mjs";
import { createHistory, createLineReader, createStderrBuffer, createUsageTotals, joinTextParts, truncateUtf8, BATCH_OUTPUT_BYTES, FINAL_BYTES } from "./output.mjs";

const MAX_PARALLEL_TASKS = 32;
const COLLAPSED_ITEM_COUNT = 10;
const MODEL_VISIBLE_OUTPUT_CAP = 16 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

type TaskStatus = "queued" | "running" | "completed" | "failed" | "aborted";

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	/** Process exit code; -1 until a child has finished. Independent of `status`. */
	exitCode: number;
	/** Lifecycle state. Absent on results stored before states existed. */
	status?: TaskStatus;
	messages: Message[];
	stderr: string;
	/** Bounded latest assistant text, independent of rolling history eviction. */
	finalOutput?: string;
	output?: { retainedBytes: number; omittedMessages: number; shortenedMessages: number; stderrOmittedBytes: number; finalOutputTruncated?: boolean; errorMessageTruncated?: boolean };
	usage: UsageStats;
	/** Full Pi usage for all assistant and nested tool-result work, never evicted. */
	fullUsage?: Usage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function emptyUsage(): Usage {
	return createUsageTotals().snapshot() as Usage;
}

function sumUsage(results: SingleResult[]): Usage {
	const totals = createUsageTotals();
	for (const result of results) totals.add(result.fullUsage);
	return totals.snapshot() as Usage;
}

function getFinalOutput(source: Message[] | SingleResult): string {
	if (!Array.isArray(source) && source.finalOutput !== undefined) return source.finalOutput;
	const messages = Array.isArray(source) ? source : source.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const text = joinTextParts(msg.content);
			if (text !== undefined) return truncateUtf8(text, FINAL_BYTES, "\n\n[Output truncated; omitted content is not retained.]");
		}
	}
	return "";
}

/** Effective state; results without `status` (older stored calls) derive it from exitCode. */
function getStatus(result: SingleResult): TaskStatus {
	if (result.status) return result.status;
	if (result.exitCode === -1) return "running";
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"
		? "failed"
		: "completed";
}

function isPending(result: SingleResult): boolean {
	const status = getStatus(result);
	return status === "queued" || status === "running";
}

function isFailedResult(result: SingleResult): boolean {
	const status = getStatus(result);
	if (status === "failed" || status === "aborted") return true;
	return status === "completed" && (result.stopReason === "error" || result.stopReason === "aborted");
}

const NORMAL_STOP_REASONS = new Set(["stop", "end", "toolUse"]);

/** Why a failed result failed: a meaningful stop reason, else the exit code, else undefined. */
function getFailureReason(result: SingleResult): string | undefined {
	if (result.stopReason && !NORMAL_STOP_REASONS.has(result.stopReason)) return result.stopReason;
	if (result.exitCode > 0) return `exit ${result.exitCode}`;
	return undefined;
}

function getResultOutput(result: SingleResult): string {
	const text = isFailedResult(result)
		? result.errorMessage || result.stderr || getFinalOutput(result) || "(no output)"
		: getFinalOutput(result) || "(no output)";
	const output = result.output;
	const discarded = isFailedResult(result)
		? result.errorMessage ? output?.errorMessageTruncated : result.stderr ? output?.stderrOmittedBytes : output?.finalOutputTruncated
		: output?.finalOutputTruncated;
	return discarded ? `[Output truncated; omitted original text is not retained. Tool details contain a bounded preview.]\n\n${text}` : text;
}

function truncateModelVisibleOutput(output: string, maxBytes = MODEL_VISIBLE_OUTPUT_CAP): string {
	return truncateUtf8(output, maxBytes);
}

/** Failure text for views: provider error, else process stderr/notes; undefined when only a final answer exists. */
function getFailureDiagnostic(result: SingleResult): string | undefined {
	if (isPending(result) || !isFailedResult(result) || !(result.errorMessage || result.stderr)) return undefined;
	return truncateModelVisibleOutput(getResultOutput(result));
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	try {
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
		});
	} catch (error) {
		await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type ChildRunner = ReturnType<typeof createChildRunner>;

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

async function runSingleAgent(
	runner: ChildRunner,
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	consultation = false,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	// Unknown agents fail immediately and never wait for a child slot.
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			status: "failed",
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			fullUsage: emptyUsage(),
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	args.push("--tools", consultation ? "read,grep,find,ls" : agent.tools.join(","));
	if (consultation) args.push("--no-mcp");

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		status: "queued",
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		fullUsage: emptyUsage(),
		model,
		step,
	};

	const history = createHistory();
	const usageTotals = createUsageTotals();
	const stderr = createStderrBuffer();
	currentResult.messages = history.messages;
	let errorMessageTruncated = false;
	const updateOutput = () => {
		currentResult.finalOutput = history.finalOutput;
		currentResult.output = { ...history.stats, stderrOmittedBytes: stderr.omittedBytes, errorMessageTruncated };
		currentResult.stderr = stderr.text;
		currentResult.fullUsage = usageTotals.snapshot() as Usage;
	};
	const emitUpdate = () => {
		updateOutput();
		if (onUpdate) {
			const placeholder = currentResult.status === "queued" ? "(queued...)" : "(running...)";
			onUpdate({
				content: [{ type: "text", text: truncateModelVisibleOutput(getFinalOutput(currentResult) || placeholder) }],
				details: makeDetails([currentResult]),
			});
		}
	};

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (event.type === "message_end" && event.message) {
			const msg = event.message as Message;
			history.append(msg);

			// Usage is collected from message_end only; tool_result_end may mirror it.
			const messageUsage = (msg as { usage?: Usage }).usage;
			if ((msg.role === "assistant" || msg.role === "toolResult") && messageUsage) {
				usageTotals.add(messageUsage);
				const total = usageTotals.snapshot();
				currentResult.usage.input = total.input;
				currentResult.usage.output = total.output;
				currentResult.usage.cacheRead = total.cacheRead;
				currentResult.usage.cacheWrite = total.cacheWrite;
				currentResult.usage.cost = total.cost.total;
			}
			if (msg.role === "assistant") {
				currentResult.usage.turns++;
				if (messageUsage) currentResult.usage.contextTokens = messageUsage.totalTokens || 0;
				if (!currentResult.model && msg.model) currentResult.model = truncateUtf8(msg.model, 256, "...");
				if (msg.stopReason) currentResult.stopReason = truncateUtf8(msg.stopReason, 128, "...");
				if (msg.errorMessage) {
					errorMessageTruncated = Buffer.byteLength(msg.errorMessage) > FINAL_BYTES;
					currentResult.errorMessage = truncateUtf8(msg.errorMessage, FINAL_BYTES,
						"\n\n[Error shortened; omitted original text is not retained.]");
				}
			}
			emitUpdate();
		}

		if (event.type === "tool_result_end" && event.message) {
			history.append(event.message as Message);
			emitUpdate();
		}
	};

	const lines = createLineReader(processLine);
	const outcome = await runner.run({
		signal,
		// Runs after a child slot is acquired, so queued tasks create no temp files.
		prepare: async () => {
			const spawnArgs = [...args];
			if (agent.systemPrompt.trim()) {
				const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
				tmpPromptDir = tmp.dir;
				tmpPromptPath = tmp.filePath;
				spawnArgs.push("--append-system-prompt", tmpPromptPath);
			}
			spawnArgs.push(`Task: ${task}`);
			const invocation = getPiInvocation(spawnArgs);
			return { command: invocation.command, args: invocation.args, cwd: cwd ?? defaultCwd };
		},
		cleanup: () => {
			if (tmpPromptPath)
				try {
					fs.unlinkSync(tmpPromptPath);
				} catch {
					/* ignore */
				}
			if (tmpPromptDir)
				try {
					fs.rmdirSync(tmpPromptDir);
				} catch {
					/* ignore */
				}
		},
		onState: (state: TaskStatus) => {
			currentResult.status = state;
			emitUpdate();
		},
		onStdout: (data: Buffer) => lines.write(data),
		onStderr: (data: Buffer) => stderr.write(data),
	});

	lines.end();
	stderr.end();
	updateOutput();

	currentResult.exitCode = outcome.exitCode ?? 1;
	const note = (text: string) => {
		stderr.write(Buffer.from(`${stderr.text && !stderr.text.endsWith("\n") ? "\n" : ""}${text}`));
		updateOutput();
	};
	if (outcome.error) note(`Subagent process error: ${outcome.error}`);
	if (outcome.signal && outcome.status !== "aborted") note(`Subagent terminated by signal ${outcome.signal}`);

	if (outcome.status === "aborted") {
		currentResult.status = "aborted";
		currentResult.stopReason = "aborted";
		currentResult.errorMessage ||= "Subagent was aborted";
	} else if (outcome.status === "failed") {
		currentResult.status = "failed";
	} else if (currentResult.stopReason === "aborted") {
		currentResult.status = "aborted";
	} else if (currentResult.stopReason === "error") {
		currentResult.status = "failed";
	} else {
		currentResult.status = "completed";
	}
	return currentResult;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Only "user" is enabled. Project-local scopes are rejected.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { maxItems: MAX_PARALLEL_TASKS, description: "Up to 32 tasks; active concurrency is configured separately" })),
	maxConcurrency: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 16,
			description:
				"Parallel mode only. Raise the number of active subagents for this call, clamped to the configured ceiling. Never lowers the limit. Use for independent read-only work (exploration, review), not concurrent edits.",
		}),
	),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Disabled; retained for stored-call compatibility" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Ignored because project-local agents are disabled", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	// Validated once at load. An invalid setting disables spawning and is reported by the tool.
	let limits = { base: 6, ceiling: 8 };
	let configError: string | undefined;
	try {
		limits = parseConcurrency(process.env);
	} catch (error) {
		configError = error instanceof Error ? error.message : String(error);
	}
	// One runner per extension runtime: single and parallel calls share its FIFO limiter.
	const runner: ChildRunner = createChildRunner({ capacity: limits.base, ceiling: limits.ceiling, spawn });

	// Pi awaits this before tearing the runtime down (quit, reload, session replacement).
	pi.on("session_shutdown", async () => {
		await runner.shutdown();
	});

	// The model can only name agents it knows about. List them here so no AGENTS.md roster is
	// needed. Read once at load; add or rename agents, then /reload.
	let rosterText = "No user-level agents are defined yet.";
	try {
		rosterText = describeAgents(discoverAgents(process.cwd(), "user").agents);
	} catch {
		/* a broken agents directory must not prevent the tool from loading */
	}

	let consultationAttempted = false;
	pi.registerTool({
		name: "consult_advisor",
		label: "Consult advisor",
		description: "Consult the user-level advisor for a bounded read-only decision. It does not inherit your conversation; supply the objective, acceptance criteria, constraints, current changes, evidence, and proposed approach.",
		promptSnippet: "Ask the advisor a focused decision question",
		promptGuidelines: [
			"Consult after initial inspection, before a consequential approach with unresolved assumptions or compatibility risks, or when investigation stops converging. Skip routine work. One attempt is allowed per runtime, including failures; escalate further uncertainty to the parent. Keep the brief focused.",
			"The advisor recommends; you own the decision and verification. It cannot edit, run shell commands, or delegate.",
			"Passing supplied tests does not override the requirements. Investigate advisor-identified correctness risks even when tests omit them. Resolve confirmed in-scope defects and add regression coverage when test edits are permitted. If a required fix or test is outside your ownership, or a material correctness risk remains unresolved, return it as a blocking gap; do not claim completion.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Objective, acceptance criteria, constraints, current changes, file evidence and exact failures if any; decision needed, options, and proposed approach" }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the advisor process" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal, observer, ctx) {
			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				mode: "single", agentScope: "user", projectAgentsDir: null, results,
			});
			if (consultationAttempted) return {
				content: [{ type: "text", text: "Advisor consultation already attempted in this runtime. Escalate to the parent instead of retrying." }],
				details: makeDetails([]), isError: true,
			};
			// Claim before discovery, preparation, or any await. Failures also consume the attempt.
			consultationAttempted = true;
			if (configError) return {
				content: [{ type: "text", text: `Advisor consultation is disabled: ${configError}` }],
				details: makeDetails([]), isError: true,
			};
			const onUpdate: OnUpdateCallback | undefined = observer ? (partial) => {
				try { observer(partial); } catch { /* ignore observer failures */ }
			} : undefined;
			const result = await runSingleAgent(
				runner, ctx.cwd,
				{ model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinkingLevel: ctx.thinkingLevel },
				discoverAgents(ctx.cwd, "user").agents, "advisor", params.task, params.cwd,
				undefined, signal, onUpdate, makeDetails, true,
			);
			return {
				content: [{ type: "text", text: truncateModelVisibleOutput(getResultOutput(result)) }],
				details: makeDetails([result]), usage: sumUsage([result]), isError: isFailedResult(result),
			};
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate focused tasks to user-level subagents with isolated context.",
			"Supported modes: single (agent + task) and parallel (tasks array, maximum 32).",
			`At most ${limits.base} subagent processes run at once per Pi runtime (PI_SUBAGENT_MAX_CONCURRENCY, 1-16); extra tasks wait in FIFO order.`,
			`In parallel mode, maxConcurrency may raise that to at most ${limits.ceiling} for the call; use it only for independent read-only work.`,
			`Agents are loaded from ${path.join(getAgentDir(), "agents")}.`,
			rosterText,
			"Chain and project-agent modes are disabled.",
		].join(" "),
		promptSnippet: "Delegate focused tasks to subagents with isolated context, singly or in parallel",
		// Appended to the system prompt while the tool is active, so no AGENTS.md entry is needed.
		promptGuidelines: [
			"Use subagent for work that splits into independent parts, or whose output is much larger than its conclusion (broad searches, reviews, noisy checks). Do small or sequential work yourself.",
			"Give each subagent a self-contained brief: goal, scope, constraints and the exact result to return. It cannot see this conversation.",
			"Run independent subagent tasks in one parallel call. Do not give parallel tasks overlapping writable files; prefer read-only work for parallel fan-out.",
			"Treat subagent results as unverified. Check them against the actual changes before reporting success.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, observer, ctx) {
			// UI observers are best-effort and must not break child execution or cleanup.
			const onUpdate = observer ? (partial: AgentToolResult<SubagentDetails>) => {
				try { observer(partial); } catch { /* ignore observer failures */ }
			} : undefined;
			if (configError) {
				return {
					content: [{ type: "text", text: `Subagent is disabled: ${configError}` }],
					details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] },
					isError: true,
				};
			}
			const requestedScope: AgentScope = params.agentScope ?? "user";
			if (requestedScope !== "user") {
				return {
					content: [{ type: "text", text: "Project-local subagents are disabled." }],
					details: { mode: "single", agentScope: requestedScope, projectAgentsDir: null, results: [] },
				};
			}
			const agentScope: AgentScope = "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (hasChain) {
				return {
					content: [{ type: "text", text: "Chain mode is disabled; return each result to the parent for review." }],
					details: makeDetails("chain")([]),
				};
			}

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						runner,
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [
							{ type: "text", text: truncateModelVisibleOutput(`Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`) },
						],
							details: makeDetails("chain")(results),
							usage: sumUsage(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1]) || "(no output)" }],
					details: makeDetails("chain")(results),
					usage: sumUsage(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = no exit yet; see status
						status: "queued",
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						fullUsage: emptyUsage(),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const queued = allResults.filter((r) => getStatus(r) === "queued").length;
						const running = allResults.filter((r) => getStatus(r) === "running").length;
						const done = allResults.length - queued - running;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running, ${queued} queued...`,
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				// The shared limiter bounds active children; every task keeps its own result.
				// A raise lasts only for this call so it cannot leak into later calls.
				const lowerLimit = params.maxConcurrency ? runner.raise(params.maxConcurrency) : undefined;
				// Say so when the request could not be honored, so the model does not assume more parallelism.
				const requested = params.maxConcurrency;
				const limitNote =
					requested === undefined
						? ""
						: requested > limits.ceiling
							? `Note: maxConcurrency ${requested} was clamped to the ceiling of ${limits.ceiling}.\n\n`
							: requested <= limits.base
								? `Note: maxConcurrency ${requested} did not raise the limit; it only raises above ${limits.base}.\n\n`
								: "";
				let results: SingleResult[];
				try {
				results = await Promise.all(
					params.tasks.map(async (t, index) => {
						let result: SingleResult;
						try {
							result = await runSingleAgent(
								runner,
								ctx.cwd,
								dispatchDefaults,
								agents,
								t.agent,
								t.task,
								t.cwd,
								undefined,
								signal,
								// Per-task update callback
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										emitParallelUpdate();
									}
								},
								makeDetails("parallel"),
							);
						} catch (error) {
							result = {
								...allResults[index],
								exitCode: 1,
								status: "failed",
								stderr: error instanceof Error ? error.message : String(error),
							};
						}
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					}),
				);
				} finally {
					lowerLimit?.();
				}

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const headers = results.map((r) => {
					const status =
						getStatus(r) === "aborted"
							? "aborted"
							: isFailedResult(r)
								? `failed${getFailureReason(r) ? ` (${getFailureReason(r)})` : ""}`
								: "completed";
					return `### [${truncateUtf8(r.agent, 128, "...")}] ${status}\n\n`;
				});
				const prefix = `${limitNote}Parallel: ${successCount}/${results.length} succeeded\n\n`;
				const separator = "\n\n---\n\n";
				const overhead = Buffer.byteLength(prefix + headers.join(separator));
				const outputs = results.map(getResultOutput);
				const demands = outputs.map((text, index) => ({ index, bytes: Math.min(MODEL_VISIBLE_OUTPUT_CAP, Buffer.byteLength(text)) }))
					.sort((a, b) => a.bytes - b.bytes);
				const budgets = new Array<number>(results.length);
				let remaining = BATCH_OUTPUT_BYTES - overhead;
				for (let i = 0; i < demands.length; i++) {
					const { index, bytes } = demands[i];
					budgets[index] = Math.min(bytes, Math.floor(remaining / (demands.length - i)));
					remaining -= budgets[index];
				}
				const summaries = results.map((_r, i) => headers[i] + truncateModelVisibleOutput(outputs[i], budgets[i]));
				return {
					content: [
						{
							type: "text",
							text: prefix + summaries.join(separator),
						},
					],
					details: makeDetails("parallel")(results),
					usage: sumUsage(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					runner,
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{ type: "text", text: truncateModelVisibleOutput(`Agent ${result.stopReason && !NORMAL_STOP_REASONS.has(result.stopReason) ? result.stopReason : `failed${getFailureReason(result) ? ` (${getFailureReason(result)})` : ""}`}: ${errorMsg}`) },
						],
						details: makeDetails("single")([result]),
						usage: sumUsage([result]),
						isError: true,
					};
				}
				return {
					content: [
						{ type: "text", text: truncateModelVisibleOutput(getResultOutput(result)) },
					],
					details: makeDetails("single")([result]),
					usage: sumUsage([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const statusIcon = (r: SingleResult, t: typeof theme) => {
				const status = getStatus(r);
				if (status === "queued" || status === "running") return t.fg("warning", "⏳");
				if (status === "aborted") return t.fg("warning", "⊘");
				return isFailedResult(r) ? t.fg("error", "✗") : t.fg("success", "✓");
			};
			const placeholderFor = (r: SingleResult) => {
				const status = getStatus(r);
				return status === "queued" ? "(queued...)" : status === "running" ? "(running...)" : "(no output)";
			};

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const pending = isPending(r);
				const icon = statusIcon(r, theme);
				const stateLabel = pending ? theme.fg("warning", ` [${getStatus(r)}]`) : "";
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r);
				const diagnostic = getFailureDiagnostic(r);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${stateLabel}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (diagnostic) container.addChild(new Text(theme.fg("error", `Error: ${diagnostic}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						if (!diagnostic) container.addChild(new Text(theme.fg("muted", placeholderFor(r)), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = pending ? "" : formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${stateLabel}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (diagnostic) text += `\n${theme.fg("error", `Error: ${diagnostic}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", finalOutput ? truncateModelVisibleOutput(finalOutput) : placeholderFor(r))}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = pending ? "" : formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => getStatus(r) === "running").length;
				const queued = details.results.filter((r) => getStatus(r) === "queued").length;
				const successCount = details.results.filter((r) => !isPending(r) && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => !isPending(r) && isFailedResult(r)).length;
				const isRunning = running + queued > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running, ${queued} queued`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = statusIcon(r, theme);
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						const diagnostic = getFailureDiagnostic(r);
						if (diagnostic) container.addChild(new Text(theme.fg("error", `Error: ${diagnostic}`), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon = statusIcon(r, theme);
					const displayItems = getDisplayItems(r.messages);
					const rState = isPending(r) ? theme.fg("warning", ` [${getStatus(r)}]`) : "";
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}${rState}`;
					const diagnostic = getFailureDiagnostic(r);
					if (diagnostic) text += `\n${theme.fg("error", `Error: ${diagnostic}`)}`;
					else if (displayItems.length === 0) text += `\n${theme.fg("muted", getFinalOutput(r) ? truncateModelVisibleOutput(getFinalOutput(r)) : placeholderFor(r))}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
