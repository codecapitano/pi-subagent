/** Assemble bytes before decoding so split multibyte characters remain intact. */
export function createLineReader(onLine, maxBytes = LINE_BYTES) {
	let buffer = Buffer.alloc(0);
	let size = 0;
	const reset = () => { buffer = Buffer.alloc(0); size = 0; };
	const append = (bytes) => {
		if (size + bytes.length > maxBytes) {
			reset();
			throw new Error(`Subagent stdout line exceeded ${maxBytes} bytes`);
		}
		if (size + bytes.length > buffer.length) {
			const grown = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(size + bytes.length, 1024, buffer.length * 2)));
			buffer.copy(grown, 0, 0, size);
			buffer = grown;
		}
		bytes.copy(buffer, size);
		size += bytes.length;
	};
	const flush = () => {
		const text = buffer.subarray(0, size).toString("utf8");
		reset();
		onLine(text);
	};
	return {
		write(chunk) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			let start = 0;
			let newline;
			while ((newline = bytes.indexOf(10, start)) !== -1) {
				append(bytes.subarray(start, newline));
				flush();
				start = newline + 1;
			}
			append(bytes.subarray(start));
		},
		end() { if (size) flush(); },
		get retainedBytes() { return size; },
	};
}

import { StringDecoder } from "node:string_decoder";

/** Concatenates every text part in order with no separator; undefined when there is no text part. */
export function joinTextParts(content) {
	if (!Array.isArray(content)) return undefined;
	let found = false;
	let text = "";
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") { found = true; text += part.text; }
	}
	return found ? text : undefined;
}

/** Rolling history; usage accounting belongs to the caller and is never evicted. */
export function createHistory(maxBytes = HISTORY_BYTES) {
	if (maxBytes < 256) throw new Error("History budget must be at least 256 bytes");
	const messages = [];
	const sizes = [];
	let retainedBytes = 2;
	let omittedMessages = 0;
	let shortenedMessages = 0;
	let finalOutput;
	let finalOutputTruncated = false;
	return {
		messages,
		append(message) {
			const text = message.role === "assistant" ? joinTextParts(message.content) : undefined;
			if (typeof text === "string") {
				finalOutputTruncated = Buffer.byteLength(text) > FINAL_BYTES;
				finalOutput = truncateUtf8(text, FINAL_BYTES,
					"\n\n[Output truncated; omitted content is not retained.]");
			}
			let stored = message;
			let bytes = Buffer.byteLength(JSON.stringify(stored)) + 1;
			if (bytes + 2 > maxBytes) {
				shortenedMessages++;
				let budget = Math.min(FINAL_BYTES, maxBytes - 128);
				do {
					stored = { role: message.role === "assistant" ? "assistant" : "toolResult", content: [{ type: "text",
						text: truncateUtf8(typeof text === "string" ? text : "[Message omitted; content is not retained.]", budget,
							"\n\n[Message shortened; omitted content is not retained.]") }] };
					bytes = Buffer.byteLength(JSON.stringify(stored)) + 1;
					budget = Math.floor(budget / 2);
				} while (bytes + 2 > maxBytes);
			}
			while (messages.length && retainedBytes + bytes > maxBytes) {
				messages.shift(); retainedBytes -= sizes.shift(); omittedMessages++;
			}
			messages.push(stored); sizes.push(bytes); retainedBytes += bytes;
		},
		get finalOutput() { return finalOutput; },
		get stats() { return { retainedBytes, omittedMessages, shortenedMessages, finalOutputTruncated }; },
	};
}

export function createStderrBuffer(maxBytes = STDERR_BYTES) {
	const decoder = new StringDecoder("utf8");
	let text = "";
	let omittedBytes = 0;
	const append = (value) => {
		const bytes = Buffer.from(text + value);
		let start = Math.max(0, bytes.length - maxBytes);
		while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
		omittedBytes += start;
		text = bytes.subarray(start).toString("utf8");
	};
	return {
		write(chunk) { append(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))); },
		end() { append(decoder.end()); },
		get text() { return text; },
		get omittedBytes() { return omittedBytes; },
	};
}

export const HISTORY_BYTES = 1024 * 1024;
export const STDERR_BYTES = 64 * 1024;
export const LINE_BYTES = 8 * 1024 * 1024;
export const FINAL_BYTES = 64 * 1024;
export const BATCH_OUTPUT_BYTES = 128 * 1024;

function prefix(bytes, limit) {
	let end = Math.max(0, Math.min(limit, bytes.length));
	while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

/** Includes the omission notice in the budget and never splits a UTF-8 character. */
export function truncateUtf8(text, maxBytes, notice = "\n\n[Output truncated; retained output is in tool details.]") {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	const suffix = prefix(Buffer.from(notice), maxBytes);
	return prefix(bytes, maxBytes - Buffer.byteLength(suffix)) + suffix;
}

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Sums Pi `Usage` objects. Optional subsets appear only once some provider reported them. */
export function createUsageTotals() {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	let cacheWrite1h;
	let reasoning;
	const api = {
		add(usage) {
			if (!usage || typeof usage !== "object") return api;
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) total[key] += num(usage[key]);
			const cost = usage.cost ?? {};
			const components = ["input", "output", "cacheRead", "cacheWrite"];
			for (const key of components) total.cost[key] += num(cost[key]);
			total.cost.total += typeof cost.total === "number" && Number.isFinite(cost.total)
				? cost.total : components.reduce((sum, key) => sum + num(cost[key]), 0);
			if (typeof usage.cacheWrite1h === "number") cacheWrite1h = (cacheWrite1h ?? 0) + num(usage.cacheWrite1h);
			if (typeof usage.reasoning === "number") reasoning = (reasoning ?? 0) + num(usage.reasoning);
			return api;
		},
		snapshot() {
			return {
				...total,
				...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
				...(reasoning === undefined ? {} : { reasoning }),
				cost: { ...total.cost },
			};
		},
	};
	return api;
}
