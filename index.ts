/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Local policy supports two modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 * Either can run in its own git worktree (`isolation`) or as a background job (`background`),
 * which also lets a child ask the parent a question (`ask_parent`).
 *
 * Chain and project-agent execution from the upstream example are retained only
 * for compatibility with stored calls and rejected before execution.
 *
 * Uses JSON mode to capture structured output from subagents. Background tasks of agents that
 * list `ask_parent` use RPC mode instead, so the child can ask the parent a question.
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
import { createLane, describeLaneState, finishLane, formatLane, runSetup } from "./worktree.mjs";
import { createHistory, createLineReader, createStderrBuffer, createUsageTotals, joinTextParts, truncateUtf8, BATCH_OUTPUT_BYTES, FINAL_BYTES } from "./output.mjs";

const MAX_PARALLEL_TASKS = 32;
const COLLAPSED_ITEM_COUNT = 10;
const MODEL_VISIBLE_OUTPUT_CAP = 16 * 1024;
/** Dialog title prefix that marks a child's `ask_parent` question; any other dialog is declined. */
const ASK_PREFIX = "ask_parent: ";
const ASK_TIMEOUT_ENV = "PI_SUBAGENT_ASK_TIMEOUT_MS";
const ASK_TIMEOUT_MS = 10 * 60 * 1000;
const QUESTION_BYTES = 4096;

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

/** Final state of an isolated lane; see `finishLane` in worktree.mjs. */
interface WorktreeInfo {
	path: string;
	branch: string;
	base: string;
	commitsAhead: number;
	/** The extension committed the lane's changes after the child finished. */
	committed: boolean;
	dirty: boolean;
	/** The parent checkout had uncommitted changes the lane does not contain. */
	parentDirty: boolean;
	commitError?: string;
	/** Exact commands that remove the lane and its branch once merged. */
	cleanup: string[];
}

interface Job {
	id: string;
	status: "running" | "completed" | "cancelled";
	results: SingleResult[];
	/** Set once delivered, when the heavy results are dropped. */
	taskStates?: { agent: string; status: TaskStatus }[];
	controller: AbortController;
	done: Promise<void>;
	delivered: boolean;
	/** The caller (subagent_cancel) will take the output, so completion must not deliver it. */
	holding: boolean;
	/** Open questions from this job's children, by the id the parent answers with. */
	questions: Map<string, Question>;
}

interface Question {
	id: string;
	jobId: string;
	taskIndex: number;
	agent: string;
	text: string;
	/** A subagent_wait result has shown it. A queued follow-up does not count: it may sit behind the current turn. */
	shown: boolean;
	respond: (answer: string | undefined) => void;
	timer?: ReturnType<typeof setTimeout>;
}

interface Wait {
	ids: Set<string>;
	check: () => void;
	finish: (reason: "done" | "timeout" | "abort" | "question") => void;
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
	worktree?: WorktreeInfo;
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

/** A child's question, as seen by the parent. `respond(undefined)` cancels it. */
interface RpcQuestion {
	requestId: string;
	question: string;
	timeoutMs?: number;
	respond: (answer: string | undefined) => void;
}

/** Background tasks whose agent lists `ask_parent` run in RPC mode and report through these hooks. */
interface RpcHooks {
	askTimeoutMs: number;
	onQuestion: (question: RpcQuestion) => void;
	onClose: () => void;
}

interface LaneRequest {
	setup?: string;
	/** Aborts setup and finalization when the extension shuts down, so they cannot block reload or quit. */
	shutdown?: AbortSignal;
	/** Registers finalization so shutdown can wait for its git processes. */
	track?: (done: Promise<unknown>) => void;
}

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
	{ consultation = false, lane, rpc }: { consultation?: boolean; lane?: LaneRequest; rpc?: RpcHooks } = {},
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
		};
	}

	// RPC lets the child ask the parent; it is used only for agents that can call ask_parent.
	const useRpc = Boolean(rpc) && !consultation && agent.tools.includes("ask_parent");
	const args: string[] = useRpc ? ["--mode", "rpc", "--no-session"] : ["--mode", "json", "-p", "--no-session"];
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

	let input: NodeJS.WritableStream | undefined;
	const send = (record: object) => {
		try {
			input?.write(`${JSON.stringify(record)}\n`);
		} catch {
			/* the child is gone */
		}
	};
	// Closing stdin is how an RPC child is asked to exit once its run has settled.
	const endInput = () => {
		try {
			input?.end();
		} catch {
			/* already closed */
		}
	};
	const handleRpcRecord = (event: any) => {
		if (event.type === "response" && event.command === "prompt") {
			if (event.success === false) {
				currentResult.stopReason = "error";
				currentResult.errorMessage = truncateUtf8(`Prompt rejected: ${event.error ?? "unknown error"}`, FINAL_BYTES);
				endInput();
			} else if (event.data?.disposition === "handled") endInput(); // no run started, so no agent_settled will follow
		} else if (event.type === "agent_settled") {
			endInput();
		} else if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
			const title = typeof event.title === "string" ? event.title : "";
			if (event.method === "input" && title.startsWith(ASK_PREFIX) && rpc) {
				const requestId = String(event.id);
				rpc.onQuestion({
					requestId,
					question: truncateUtf8(title.slice(ASK_PREFIX.length), QUESTION_BYTES, "..."),
					timeoutMs: typeof event.timeout === "number" ? event.timeout : undefined,
					respond: (answer) => send({ type: "extension_ui_response", id: requestId, ...(answer === undefined ? { cancelled: true } : { value: answer }) }),
				});
			} else {
				// Other extensions in the child now see a UI; nobody is there to answer them.
				send({ type: "extension_ui_response", id: event.id, cancelled: true });
			}
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

		if (useRpc) handleRpcRecord(event);

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
	let createdLane: Awaited<ReturnType<typeof createLane>> | undefined;
	let promptMessage = "";
	const outcome = await runner.run({
		signal,
		// Runs after a child slot is acquired, so queued tasks create no temp files.
		prepare: async () => {
			let childCwd = cwd ?? defaultCwd;
			let childTask = task;
			if (lane) {
				createdLane = await createLane({ cwd: childCwd, agent: agent.name });
				if (lane.setup) await runSetup(createdLane, lane.setup, AbortSignal.any([signal, lane.shutdown].filter((s): s is AbortSignal => !!s)));
				childCwd = createdLane.cwd;
				childTask = `${task}\n\nYou are in an isolated worktree on branch ${createdLane.branch}; edit only here.`;
			}
			const spawnArgs = [...args];
			if (agent.systemPrompt.trim()) {
				const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
				tmpPromptDir = tmp.dir;
				tmpPromptPath = tmp.filePath;
				spawnArgs.push("--append-system-prompt", tmpPromptPath);
			}
			promptMessage = `Task: ${childTask}`;
			if (!useRpc) spawnArgs.push(promptMessage);
			const invocation = getPiInvocation(spawnArgs);
			return {
				command: invocation.command,
				args: invocation.args,
				cwd: childCwd,
				...(useRpc ? { stdin: true, env: { PI_SUBAGENT_ASK_PARENT: "1", [ASK_TIMEOUT_ENV]: String(rpc!.askTimeoutMs) } } : {}),
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
		onSpawn: (proc: { stdin?: NodeJS.WritableStream | null }) => {
			if (!useRpc || !proc.stdin) return;
			input = proc.stdin;
			send({ id: "prompt", type: "prompt", message: promptMessage });
		},
		onStdout: (data: Buffer) => lines.write(data),
		onStderr: (data: Buffer) => stderr.write(data),
	});

	lines.end();
	stderr.end();
	if (useRpc) rpc!.onClose();
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
	if (createdLane) {
		// Only a completed child's work is committed; failed or aborted lanes stay as they are for inspection.
		const finishing = finishLane(createdLane, { agent: agent.name, task, commit: currentResult.status === "completed", signal: lane?.shutdown });
		lane?.track?.(finishing);
		currentResult.worktree = await finishing;
	}
	return currentResult;
}

/** Model-facing text for a finished batch: bounded per task and in total, with lane headers. */
function formatBatch(results: SingleResult[], limitNote = ""): string {
	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const headers = results.map((r) => {
		const status =
			getStatus(r) === "aborted"
				? "aborted"
				: isFailedResult(r)
					? `failed${getFailureReason(r) ? ` (${getFailureReason(r)})` : ""}`
					: "completed";
		return `### [${truncateUtf8(r.agent, 128, "...")}] ${status}\n\n${r.worktree ? `${formatLane(r.worktree)}\n\n` : ""}`;
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
	return prefix + results.map((_r, i) => headers[i] + truncateModelVisibleOutput(outputs[i], budgets[i])).join(separator);
}

interface TaskInput {
	agent: string;
	task: string;
	cwd?: string;
	isolation?: "worktree";
	setup?: string;
}

const ISOLATION_DESCRIPTION =
	"\"worktree\" runs the task in its own git worktree and branch, created from HEAD. The parent merges the branch and removes the lane afterwards.";
const SETUP_DESCRIPTION =
	"Shell command run in the new worktree before the task, for example to install dependencies. Requires isolation. It should leave tracked files unchanged.";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	isolation: Type.Optional(StringEnum(["worktree"] as const, { description: ISOLATION_DESCRIPTION })),
	setup: Type.Optional(Type.String({ description: SETUP_DESCRIPTION })),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { maxItems: MAX_PARALLEL_TASKS, description: "Up to 32 independent tasks" })),
	maxConcurrency: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 16,
			description: "Parallel mode only. Raise active subagents for this call, up to the configured ceiling. For independent read-only work only.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	background: Type.Optional(
		Type.Boolean({
			description: "Start the work and return a job id at once. The result arrives later as a follow-up message, or from subagent_wait. Cannot be combined with maxConcurrency.",
		}),
	),
	isolation: Type.Optional(StringEnum(["worktree"] as const, { description: `${ISOLATION_DESCRIPTION} (single mode)` })),
	setup: Type.Optional(Type.String({ description: `${SETUP_DESCRIPTION} (single mode)` })),
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

	// Worktree setup commands run before a child exists, so the runner cannot stop them.
	const shutdownController = new AbortController();
	const finalizing = new Set<Promise<unknown>>();
	const trackFinalization = (done: Promise<unknown>) => {
		finalizing.add(done);
		void done.then(() => finalizing.delete(done), () => finalizing.delete(done));
	};

	// Background jobs live only in this runtime; a reload or quit stops them.
	const jobs = new Map<string, Job>();
	const waits = new Set<Wait>();
	let jobCounter = 0;
	// After shutdown the captured `pi` is stale, so nothing is delivered any more.
	let closed = false;

	const taskStates = (job: Job) => job.taskStates ?? job.results.map((r) => ({ agent: r.agent, status: getStatus(r) }));
	const jobText = (job: Job) => `Job ${job.id} ${job.status}\n\n${formatBatch(job.results)}`;
	// Delivered jobs keep only their task states, so finished work does not hold full histories.
	const markDelivered = (job: Job) => {
		job.taskStates = taskStates(job);
		job.results = [];
		job.delivered = true;
	};
	const consume = (job: Job, taken: SingleResult[]) => {
		taken.push(...job.results);
		const text = jobText(job);
		markDelivered(job);
		return text;
	};
	// A queued follow-up cannot be recalled, so each job is delivered exactly once, here or to a wait.
	const followUp = (customType: string, content: string, details: object): boolean => {
		if (closed) return false;
		try {
			const sent: unknown = pi.sendMessage({ customType, content, display: true, details }, { triggerTurn: true, deliverAs: "followUp" });
			void Promise.resolve(sent).catch(() => {});
			return true;
		} catch {
			return false; // the output stays undelivered, so a later subagent_wait can still fetch it
		}
	};
	const deliver = (job: Job) => {
		if (job.delivered) return;
		if (followUp("subagent-job", jobText(job), { jobId: job.id, status: job.status, tasks: taskStates(job) })) markDelivered(job);
	};

	// Questions from background children. Unanswered, the child's own timeout fires and it continues.
	const askTimeoutMs = Number(process.env[ASK_TIMEOUT_ENV]) > 0 ? Number(process.env[ASK_TIMEOUT_ENV]) : ASK_TIMEOUT_MS;
	let questionCounter = 0;
	const questionText = (q: Question, minutes: number) =>
		`Question ${q.id} from ${q.agent} (task ${q.taskIndex + 1} of ${q.jobId}): ${q.text}\n` +
		`Answer with subagent_reply({ jobId: "${q.jobId}", requestId: "${q.id}", answer }). ` +
		`Unanswered, it expires in ${minutes} min and the child continues on its own assumption.`;
	const pendingQuestions = (job: Job) => [...job.questions.values()].filter((q) => !q.shown);
	const closeQuestions = (job: Job, taskIndex: number) => {
		for (const q of [...job.questions.values()]) {
			if (q.taskIndex !== taskIndex) continue;
			clearTimeout(q.timer);
			job.questions.delete(q.id);
		}
	};
	const rpcHooks = (job: Job, taskIndex: number): RpcHooks => ({
		askTimeoutMs,
		onClose: () => closeQuestions(job, taskIndex),
		onQuestion: (asked) => {
			if (closed) return asked.respond(undefined);
			const q: Question = {
				id: `q-${++questionCounter}`,
				jobId: job.id,
				taskIndex,
				agent: job.results[taskIndex]?.agent ?? "agent",
				text: asked.question,
				shown: false,
				respond: asked.respond,
			};
			// The child resolves its own dialog at the same timeout; this only forgets the request.
			const ms = asked.timeoutMs ?? askTimeoutMs;
			q.timer = setTimeout(() => job.questions.delete(q.id), ms);
			q.timer.unref?.();
			job.questions.set(q.id, q);
			const covering = [...waits].filter((w) => w.ids.has(job.id));
			if (covering.length) for (const w of covering) w.check();
			else followUp("subagent-question", questionText(q, Math.max(1, Math.round(ms / 60000))), { jobId: job.id, requestId: q.id, agent: q.agent });
		},
	});
	const settle = (job: Job) => {
		job.status = job.controller.signal.aborted ? "cancelled" : "completed";
		if (closed) return;
		const covering = [...waits].filter((w) => w.ids.has(job.id));
		for (const w of covering) w.check();
		if (!covering.length && !job.holding) deliver(job);
	};
	const startJob = (
		tasks: TaskInput[],
		run: (signal: AbortSignal, results: SingleResult[], job: Job) => Promise<unknown>,
		placeholder: (t: TaskInput) => SingleResult,
	): Job => {
		const job: Job = {
			id: `job-${++jobCounter}`,
			status: "running",
			results: tasks.map(placeholder),
			controller: new AbortController(), // not linked to the tool call: the job outlives it
			delivered: false,
			holding: false,
			questions: new Map(),
			done: Promise.resolve(),
		};
		jobs.set(job.id, job);
		job.done = run(job.controller.signal, job.results, job).then(() => settle(job), () => settle(job));
		return job;
	};

	// Pi awaits this before tearing the runtime down (quit, reload, session replacement).
	pi.on("session_shutdown", async () => {
		closed = true;
		shutdownController.abort();
		for (const job of jobs.values()) {
			job.controller.abort();
			for (const q of job.questions.values()) clearTimeout(q.timer);
		}
		for (const wait of [...waits]) wait.finish("abort");
		await runner.shutdown();
		await Promise.allSettled([...finalizing]);
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
		// Only workers that list it in their tools get it; the parent already reaches the advisor via subagent.
		defaultActive: false,
		promptGuidelines: [
			"Consult once, after initial inspection, before a consequential approach with unresolved assumptions or compatibility risks, or when investigation stops converging. Skip routine work. Failures use the attempt; escalate further uncertainty to the parent.",
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
				signal, onUpdate, makeDetails, { consultation: true },
			);
			return {
				content: [{ type: "text", text: truncateModelVisibleOutput(getResultOutput(result)) }],
				details: makeDetails([result]), usage: sumUsage([result]), isError: isFailedResult(result),
			};
		},
	});

	const jobDetails: SubagentDetails = { mode: "parallel", agentScope: "user", projectAgentsDir: null, results: [] };
	const textResult = (text: string, extra: { usage?: Usage; isError?: boolean } = {}) => ({
		content: [{ type: "text" as const, text }],
		details: jobDetails,
		...extra,
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent status",
		description: "List background subagent jobs started with subagent background: true, with the state of each task.",
		promptSnippet: "List background subagent jobs and their task states",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			if (jobs.size === 0) return textResult("No background jobs.");
			const lines = [...jobs.values()].map((job) => {
				const states = taskStates(job);
				const done = states.filter((t) => t.status !== "queued" && t.status !== "running").length;
				const note = job.delivered ? ", output delivered" : job.status === "running" ? "" : ", output not yet delivered";
				const open = [...job.questions.values()].map((q) => `\n  open question ${q.id} from ${q.agent}: ${truncateUtf8(q.text, 120, "...")}`).join("");
				return `${job.id} ${job.status}: ${done}/${states.length} tasks done${note} [${states.map((t) => `${t.agent}: ${t.status}`).join(", ")}]${open}`;
			});
			return textResult(lines.join("\n"));
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent wait",
		description:
			"Block until the given background jobs finish, then return their output. Use it only when you have nothing else to do meanwhile; otherwise keep working, because each job's output also arrives as a follow-up message. With timeoutMs, returns what has finished and the state of the rest. A job whose output was already delivered is not returned again.",
		promptSnippet: "Wait for background subagent jobs and return their output",
		parameters: Type.Object({
			jobIds: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_PARALLEL_TASKS, description: "Job ids returned by subagent with background: true" }),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Stop waiting after this many milliseconds" })),
		}),
		async execute(_toolCallId, params, signal) {
			const unknown = params.jobIds.filter((id) => !jobs.has(id));
			if (unknown.length) return textResult(`Unknown job: ${unknown.join(", ")}. Use subagent_status to list jobs.`, { isError: true });
			const sections: string[] = [];
			const ids = new Set<string>();
			for (const id of new Set(params.jobIds)) {
				if (jobs.get(id)!.delivered) sections.push(`Job ${id}: output was already delivered.`);
				else ids.add(id);
			}
			let reason: "done" | "timeout" | "abort" | "question" = "done";
			if (ids.size) {
				const wait: Wait = { ids, check: () => {}, finish: () => {} };
				let timer: ReturnType<typeof setTimeout> | undefined;
				let onAbort: (() => void) | undefined;
				try {
					await new Promise<void>((resolve) => {
						const finish = (why: typeof reason) => {
							reason = why;
							resolve();
						};
						wait.finish = finish;
						// A question wakes the wait: a follow-up message would sit queued until this turn ends.
						wait.check = () => {
							if ([...ids].every((id) => jobs.get(id)!.status !== "running")) finish("done");
							else if ([...ids].some((id) => pendingQuestions(jobs.get(id)!).length)) finish("question");
						};
						waits.add(wait);
						onAbort = () => finish("abort");
						if (signal?.aborted) onAbort();
						else signal?.addEventListener("abort", onAbort, { once: true });
						if (params.timeoutMs) timer = setTimeout(() => finish("timeout"), params.timeoutMs);
						wait.check();
					});
				} finally {
					waits.delete(wait);
					clearTimeout(timer);
					if (onAbort) signal?.removeEventListener("abort", onAbort);
				}
				if (reason === "abort") {
					// The tool result may never reach the model, so finished output goes by message instead.
					for (const id of ids) if (jobs.get(id)!.status !== "running") deliver(jobs.get(id)!);
					return textResult("Wait cancelled. Finished jobs are delivered as follow-up messages.", { isError: true });
				}
			}
			const taken: SingleResult[] = [];
			for (const id of ids) {
				const job = jobs.get(id)!;
				if (job.status === "running") {
					const states = taskStates(job);
					sections.push(`Job ${id}: still running (${states.filter((t) => t.status !== "queued" && t.status !== "running").length}/${states.length} tasks done).`);
					for (const q of pendingQuestions(job)) {
						q.shown = true;
						sections.push(questionText(q, Math.max(1, Math.round(askTimeoutMs / 60000))));
					}
				} else if (job.holding) sections.push(`Job ${id}: being cancelled; subagent_cancel returns its output.`);
				else sections.push(consume(job, taken));
			}
			return textResult(sections.join("\n\n---\n\n"), { usage: sumUsage(taken) });
		},
	});

	pi.registerTool({
		name: "subagent_reply",
		label: "Subagent reply",
		description: "Answer a question that a background subagent asked with ask_parent. Use the jobId and requestId from the question. An expired question cannot be answered; the child has already continued.",
		promptSnippet: "Answer a question from a background subagent",
		parameters: Type.Object({
			jobId: Type.String(),
			requestId: Type.String(),
			answer: Type.String({ description: "The answer, as the child should read it" }),
		}),
		async execute(_toolCallId, params) {
			const q = jobs.get(params.jobId)?.questions.get(params.requestId);
			if (!q) {
				return textResult(`Question ${params.requestId} is unknown or expired. The child already continued on its own assumption.`, { isError: true });
			}
			clearTimeout(q.timer);
			jobs.get(params.jobId)!.questions.delete(q.id);
			q.respond(params.answer);
			return textResult(`Answer sent to ${q.agent}.`);
		},
	});

	// Runs in the child. Only agents that list it get it; it needs the RPC transport a background job provides.
	pi.registerTool({
		name: "ask_parent",
		label: "Ask parent",
		description: "Ask the parent agent one question when you are blocked on a decision only it can make. It may take minutes and may go unanswered.",
		promptSnippet: "Ask the parent a blocking question",
		defaultActive: false,
		promptGuidelines: [
			"Ask only when you are blocked on a decision that only the parent can make, with the question and the options in one self-contained message. Do not ask for routine choices.",
			"If no answer arrives, state the assumption you are making and continue, or stop and report that you are blocked.",
		],
		parameters: Type.Object({ question: Type.String({ description: "A self-contained question, with the options you see" }) }, { additionalProperties: false }),
		async execute(_toolCallId, params, signal, _observer, ctx) {
			const noAnswer = "No answer arrived. State the assumption you are making and continue, or stop and report that you are blocked.";
			if (process.env.PI_SUBAGENT_ASK_PARENT !== "1" || ctx.mode !== "rpc") {
				return textResult("No parent can answer in this run. State your assumption and continue, or stop and report that you are blocked.");
			}
			const timeout = Number(process.env[ASK_TIMEOUT_ENV]) > 0 ? Number(process.env[ASK_TIMEOUT_ENV]) : ASK_TIMEOUT_MS;
			const answer = await ctx.ui.input(ASK_PREFIX + truncateUtf8(params.question, QUESTION_BYTES, "..."), undefined, { timeout, signal });
			return textResult(answer ? answer : noAnswer);
		},
	});

	pi.registerTool({
		name: "subagent_cancel",
		label: "Subagent cancel",
		description: "Stop a background job: running children are terminated and queued tasks never start. Returns the partial output.",
		promptSnippet: "Cancel a background subagent job",
		parameters: Type.Object({ jobId: Type.String({ description: "Job id returned by subagent with background: true" }) }),
		async execute(_toolCallId, params) {
			const job = jobs.get(params.jobId);
			if (!job) return textResult(`Unknown job: ${params.jobId}. Use subagent_status to list jobs.`, { isError: true });
			if (job.delivered) return textResult(`Job ${job.id}: output was already delivered.`);
			job.holding = true; // the output goes to this call, not to a follow-up message
			job.controller.abort();
			await job.done;
			if (job.delivered) return textResult(`Job ${job.id}: output was already delivered.`);
			const taken: SingleResult[] = [];
			const text = consume(job, taken);
			return textResult(text, { usage: sumUsage(taken) });
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
			"isolation: \"worktree\" runs a task in its own git worktree and branch; the parent merges the branch and removes the lane.",
			"background: true returns a job id at once; the result arrives as a follow-up message, or from subagent_wait. subagent_status and subagent_cancel manage jobs.",
			`Agents are loaded from ${path.join(getAgentDir(), "agents")}.`,
			rosterText,
		].join(" "),
		promptSnippet: "Delegate focused tasks to subagents with isolated context, singly or in parallel",
		// Appended to the system prompt while the tool is active, so no AGENTS.md entry is needed.
		promptGuidelines: [
			"Use subagent for work that splits into independent parts, or whose output is much larger than its conclusion (broad searches, reviews, noisy checks). Do small or sequential work yourself. Pick the agent whose description fits; do not run a fixed explore, plan, implement, review pipeline.",
			"Give each subagent a self-contained brief: goal, scope, constraints, owned files for edits, exact acceptance commands, and the exact result to return. It cannot see this conversation.",
			"Run independent tasks in one parallel call. Never give parallel tasks overlapping writable files in one checkout; run overlapping edits one after another, or give each writer isolation: \"worktree\".",
			"isolation: \"worktree\" gives a task its own git worktree and branch from HEAD, without your uncommitted changes. Add setup (for example a dependency install) when checks need it. The extension commits a completed lane's changes. It never merges or removes anything. You merge each branch with git merge (no squash), resolve conflicts and run the checks on the combined state.",
			"Remove every lane yourself as soon as its branch is merged, or after a failed lane has been inspected, using the exact commands in its result. Never add --force to remove a dirty lane without asking the user. Your final report lists any lane left in place and why.",
			"Use background: true only when you have other independent work to do while the helpers run; otherwise call subagent normally. Do not poll: the result arrives as a follow-up message, so end your turn or keep working. Call subagent_wait only when you have nothing else left to do. Dependent steps are separate waves you start yourself after a job's result. Background tasks share the same limit as blocking calls, so a blocking call can queue behind them.",
			"Treat results as unverified. Before reporting success, inspect the combined diff and check the acceptance criteria yourself.",
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
			// Removed from the schema; stored calls may still carry them and are rejected here.
			const legacy = params as { agentScope?: AgentScope; chain?: unknown[] };
			const requestedScope: AgentScope = legacy.agentScope ?? "user";
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

			const hasChain = (legacy.chain?.length ?? 0) > 0;
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

			const requests = params.tasks?.length ? params.tasks : [params];
			if (requests.some((r) => r.setup && !r.isolation)) {
				return {
					content: [{ type: "text", text: "Invalid parameters. setup requires isolation: \"worktree\"." }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}
			const laneFor = (r: { isolation?: "worktree"; setup?: string }): LaneRequest | undefined =>
				r.isolation ? { setup: r.setup, shutdown: shutdownController.signal, track: trackFinalization } : undefined;

			if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) {
				return {
					content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
					details: makeDetails("parallel")([]),
				};
			}

			const baseCwd = ctx.cwd;
			const placeholder = (t: TaskInput): SingleResult => ({
				agent: t.agent,
				agentSource: "unknown",
				task: t.task,
				exitCode: -1, // -1 = no exit yet; see status
				status: "queued",
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				fullUsage: emptyUsage(),
			});
			// The shared limiter bounds active children; every task keeps its own result in `results`.
			// Nothing here touches `ctx` or the tool call after it returns, so background jobs can reuse it.
			const runTasks = (
				tasks: TaskInput[],
				taskSignal: AbortSignal | undefined,
				results: SingleResult[],
				onChange?: () => void,
				rpcFor?: (index: number) => RpcHooks,
			) =>
				Promise.all(
					tasks.map(async (t, index) => {
						let result: SingleResult;
						try {
							result = await runSingleAgent(
								runner,
								baseCwd,
								dispatchDefaults,
								agents,
								t.agent,
								t.task,
								t.cwd,
								taskSignal,
								(partial) => {
									if (partial.details?.results[0]) {
										results[index] = partial.details.results[0];
										onChange?.();
									}
								},
								makeDetails("parallel"),
								{ lane: laneFor(t), rpc: rpcFor?.(index) },
							);
						} catch (error) {
							result = {
								...results[index],
								exitCode: 1,
								status: "failed",
								stderr: error instanceof Error ? error.message : String(error),
							};
						}
						results[index] = result;
						onChange?.();
						return result;
					}),
				);

			if (params.background) {
				if (params.maxConcurrency !== undefined) {
					// A raise would lift the limit for every caller for the whole job.
					return {
						content: [{ type: "text", text: "Invalid parameters. maxConcurrency cannot be combined with background." }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				const tasks: TaskInput[] = params.tasks?.length
					? params.tasks
					: [{ agent: params.agent!, task: params.task!, cwd: params.cwd, isolation: params.isolation, setup: params.setup }];
				const job = startJob(
					tasks,
					(taskSignal, results, started) => runTasks(tasks, taskSignal, results, undefined, (index) => rpcHooks(started, index)),
					placeholder,
				);
				return {
					content: [{ type: "text", text: `Job ${job.id} started (${tasks.length} task${tasks.length === 1 ? "" : "s"}). Its result is delivered when it finishes; keep working, or call subagent_wait.` }],
					details: makeDetails("parallel")([]),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				// Track all results for streaming updates
				const allResults: SingleResult[] = params.tasks.map(placeholder);

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
					results = await runTasks(params.tasks, signal, allResults, emitParallelUpdate);
				} finally {
					lowerLimit?.();
				}

				return {
					content: [{ type: "text", text: formatBatch(results, limitNote) }],
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
					signal,
					onUpdate,
					makeDetails("single"),
					{ lane: laneFor(params) },
				);
				const isError = isFailedResult(result);
				const laneBlock = result.worktree ? `${formatLane(result.worktree)}\n\n` : "";
				const capped = (body: string) => laneBlock + truncateModelVisibleOutput(body, MODEL_VISIBLE_OUTPUT_CAP - Buffer.byteLength(laneBlock));
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{ type: "text", text: capped(`Agent ${result.stopReason && !NORMAL_STOP_REASONS.has(result.stopReason) ? result.stopReason : `failed${getFailureReason(result) ? ` (${getFailureReason(result)})` : ""}`}: ${errorMsg}`) },
						],
						details: makeDetails("single")([result]),
						usage: sumUsage([result]),
						isError: true,
					};
				}
				return {
					content: [
						{ type: "text", text: capped(getResultOutput(result)) },
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
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", " [user]");
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
				theme.fg("muted", " [user]");
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
			const laneLine = (r: SingleResult) =>
				r.worktree ? theme.fg("muted", `⎇ ${r.worktree.branch} (${describeLaneState(r.worktree)})`) : "";
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
					if (r.worktree) container.addChild(new Text(laneLine(r), 0, 0));
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
				if (r.worktree) text += `\n${laneLine(r)}`;
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
						if (r.worktree) container.addChild(new Text(laneLine(r), 0, 0));
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
					if (r.worktree) text += `\n${laneLine(r)}`;
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
