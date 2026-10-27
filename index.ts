/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *
 * Nesting is limited to depth 1: a child may delegate only to read-only roles,
 * and a grandchild may not delegate at all (PI_SUBAGENT_DEPTH).
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
import { type AgentConfig, type AgentDiscoveryResult, describeAgents, discoverAgents, isReadOnlyAgent } from "./agents.ts";
import { createChildRunner, parseConcurrency } from "./lifecycle.mjs";
import { createHistory, createLineReader, createStderrBuffer, createUsageTotals, joinTextParts, truncateUtf8, BATCH_OUTPUT_BYTES, FINAL_BYTES } from "./output.mjs";

const MAX_PARALLEL_TASKS = 8;
const DEPTH_ENV = "PI_SUBAGENT_DEPTH";
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
		case "edit":
		case "ls": {
			const rawPath = (args.file_path || args.path || (toolName === "ls" ? "." : "...")) as string;
			return themeFg("muted", `${toolName} `) + themeFg("accent", shortenPath(rawPath));
		}
		case "find":
		case "grep": {
			const pattern = (args.pattern || (toolName === "find" ? "*" : "")) as string;
			const rawPath = (args.path || ".") as string;
			const shown = toolName === "grep" ? `/${pattern}/` : pattern;
			return themeFg("muted", `${toolName} `) + themeFg("accent", shown) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
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
}

interface SubagentDetails {
	mode: "single" | "parallel";
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
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	depth: number,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	// Unknown agents fail immediately and never wait for a child slot.
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			task,
			exitCode: 1,
			status: "failed",
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			fullUsage: emptyUsage(),
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		task,
		exitCode: -1,
		status: "queued",
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		fullUsage: emptyUsage(),
		model,
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
			// Only top-level children lead their own process group; nested ones stay in it, so one group kill reaches every descendant.
			return {
				command: invocation.command,
				args: invocation.args,
				cwd: cwd ?? defaultCwd,
				detached: depth === 0,
				env: { ...process.env, [DEPTH_ENV]: String(depth + 1) },
			};
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

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { maxItems: MAX_PARALLEL_TASKS, description: `Up to ${MAX_PARALLEL_TASKS} independent tasks` })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

function parseDepth(raw: string | undefined): number {
	return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0;
}

function guidelinesFor(depth: number): string[] {
	const brief = "Give each subagent a self-contained brief: goal, scope, constraints, owned files for edits, exact acceptance commands, and the exact result to return. It cannot see this conversation.";
	const noisy = "Redirect noisy command output to a file and read only the summary. Treat results as unverified: inspect the combined diff and check the acceptance criteria yourself before reporting success.";
	if (depth > 0) {
		return [
			"Ask the advisor once for a hard decision and the explorer for lookups. You cannot delegate edits.",
			brief,
			noisy,
		];
	}
	return [
		"Use subagent for work that splits into independent parts, or whose output is much larger than its conclusion (broad searches, reviews, noisy checks). Do small or sequential work yourself. Pick the role whose description fits; do not run a fixed explore, plan, implement, review pipeline.",
		brief,
		"Run independent tasks in one parallel call. Never give parallel writers overlapping files; run overlapping edits one after another.",
		"For multi-lane edits, settle shared contracts (API shape, types) first. You own generated files, lockfiles, and heavy or port-binding checks, and run them once on the combined state.",
		"After two or more implementer lanes, call the advisor once on the combined diff before reporting done. Small tasks get no automatic review.",
		noisy,
	];
}

const textError = (text: string): AgentToolResult<SubagentDetails> & { isError: true } => ({
	content: [{ type: "text", text }],
	details: { mode: "single", results: [] },
	isError: true,
});

export default function (pi: ExtensionAPI) {
	const depth = parseDepth(process.env[DEPTH_ENV]);
	// One runner per extension runtime: single and parallel calls share its FIFO limiter.
	const limit = parseConcurrency(process.env);
	const runner: ChildRunner = createChildRunner({ capacity: limit, spawn });

	// Pi awaits this before tearing the runtime down (quit, reload, session replacement).
	pi.on("session_shutdown", async () => {
		await runner.shutdown();
	});

	// Nested callers see and may use read-only roles only.
	const visible = (discovery: AgentDiscoveryResult): AgentDiscoveryResult =>
		depth === 0 ? discovery : { ...discovery, agents: discovery.agents.filter(isReadOnlyAgent) };

	// The model can only name agents it knows about. List them here so no AGENTS.md roster is
	// needed. Read once at load; add or rename agents, then /reload.
	const rosterText = describeAgents(visible(discoverAgents()));

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate focused tasks to user-level subagents with isolated context.",
			`Supported modes: single (agent + task) and parallel (tasks array, maximum ${MAX_PARALLEL_TASKS}).`,
			`At most ${limit} subagent processes run at once per Pi runtime (PI_SUBAGENT_MAX_CONCURRENCY, 1-16); extra tasks wait in FIFO order.`,
			depth > 0 ? "Nested use accepts read-only roles only." : "",
			`Agents are loaded from ${path.join(getAgentDir(), "agents")}.`,
			rosterText,
		].filter(Boolean).join(" "),
		promptSnippet: "Delegate focused tasks to subagents with isolated context, singly or in parallel",
		// Appended to the system prompt while the tool is active, so no AGENTS.md entry is needed.
		promptGuidelines: guidelinesFor(depth),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, observer, ctx) {
			// UI observers are best-effort and must not break child execution or cleanup.
			const onUpdate = observer ? (partial: AgentToolResult<SubagentDetails>) => {
				try { observer(partial); } catch { /* ignore observer failures */ }
			} : undefined;
			if (depth >= 2) return textError(`Subagent nesting is limited to one level (${DEPTH_ENV}=${depth}); do this work yourself.`);

			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents();
			const agents = visible(discovery).agents;
			const makeDetails = (mode: "single" | "parallel") => (results: SingleResult[]): SubagentDetails => ({ mode, results });

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			if (hasTasks === hasSingle) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				return textError(`Invalid parameters. Provide either agent and task, or tasks.\nAvailable agents: ${available}`);
			}
			if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) {
				return textError(`Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
			}
			const requested = params.tasks ?? [{ agent: params.agent as string, task: params.task as string, cwd: params.cwd }];
			const refused = depth === 1
				? [...new Set(requested.map((t) => t.agent))].filter((name) => discovery.agents.some((a) => a.name === name && !isReadOnlyAgent(a)))
				: [];
			if (refused.length > 0) {
				return textError(`Nested subagents may only use read-only roles (no edit, write or subagent tools). Refused: ${refused.join(", ")}.`);
			}

			if (params.tasks) {
				// Track all results for streaming updates
				const allResults: SingleResult[] = params.tasks.map((t) => ({
					agent: t.agent,
					task: t.task,
					exitCode: -1, // -1 = no exit yet; see status
					status: "queued" as const,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					fullUsage: emptyUsage(),
				}));

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const queued = allResults.filter((r) => getStatus(r) === "queued").length;
						const running = allResults.filter((r) => getStatus(r) === "running").length;
						const done = allResults.length - queued - running;
						onUpdate({
							content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running, ${queued} queued...` }],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				// The shared limiter bounds active children; every task keeps its own result.
				const results = await Promise.all(
					params.tasks.map(async (t, index) => {
						let result: SingleResult;
						try {
							result = await runSingleAgent(
								runner, ctx.cwd, dispatchDefaults, agents, t.agent, t.task, t.cwd, signal,
								(partial) => {
									if (partial.details?.results[0]) {
										allResults[index] = partial.details.results[0];
										emitParallelUpdate();
									}
								},
								makeDetails("parallel"),
								depth,
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
				const prefix = `Parallel: ${successCount}/${results.length} succeeded\n\n`;
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
					content: [{ type: "text", text: prefix + summaries.join(separator) }],
					details: makeDetails("parallel")(results),
					usage: sumUsage(results),
				};
			}

			const result = await runSingleAgent(
				runner, ctx.cwd, dispatchDefaults, agents, requested[0].agent, requested[0].task, requested[0].cwd, signal,
				onUpdate, makeDetails("single"), depth,
			);
			const isError = isFailedResult(result);
			const output = getResultOutput(result);
			const failure = result.stopReason && !NORMAL_STOP_REASONS.has(result.stopReason)
				? result.stopReason
				: `failed${getFailureReason(result) ? ` (${getFailureReason(result)})` : ""}`;
			return {
				content: [{ type: "text", text: truncateModelVisibleOutput(isError ? `Agent ${failure}: ${output}` : output) }],
				details: makeDetails("single")([result]),
				usage: sumUsage([result]),
				...(isError ? { isError } : {}),
			};
		},

		renderCall(args, theme, _context) {
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			const text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.agent || "...");
			return new Text(`${text}\n  ${theme.fg("dim", preview)}`, 0, 0);
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
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${stateLabel}`;
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

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${stateLabel}`;
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
