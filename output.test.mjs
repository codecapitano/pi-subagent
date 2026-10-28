import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateUtf8, createLineReader, createHistory, createStderrBuffer, HISTORY_BYTES, FINAL_BYTES, STDERR_BYTES } from "./output.mjs";

test("UTF-8 truncation includes its notice within the byte budget", () => {
	const source = "😀é".repeat(1000);
	const result = truncateUtf8(source, 200);
	assert.ok(Buffer.byteLength(result) <= 200);
	assert.match(result, /Output truncated/);
	assert.doesNotMatch(result, /�/);
});

test("line decoding preserves UTF-8 split across chunks", () => {
	const lines = [];
	const reader = createLineReader((line) => lines.push(line));
	const bytes = Buffer.from('one😀é\ntwo😀');
	for (const byte of bytes) reader.write(Buffer.from([byte]));
	reader.end();
	assert.deepEqual(lines, ['one😀é', 'two😀']);
	assert.equal(reader.retainedBytes, 0);
});

for (const terminated of [false, true]) {
	test(`an oversized ${terminated ? 'complete' : 'incomplete'} line is rejected and released`, () => {
		const reader = createLineReader(() => {}, 32);
		reader.write(Buffer.from('a'.repeat(20)));
		assert.throws(() => reader.write(Buffer.from('b'.repeat(20) + (terminated ? '\n' : ''))), /stdout line exceeded/);
		assert.equal(reader.retainedBytes, 0);
	});
}

test("history eviction stays within budget and preserves the latest answer", () => {
	const history = createHistory(4096);
	for (let i = 0; i < 100; i++) history.append({ role: 'assistant', content: [{ type: 'text', text: String(i) + 'x'.repeat(200) }] });
	assert.ok(Buffer.byteLength(JSON.stringify(history.messages)) <= 4096);
	assert.ok(history.stats.omittedMessages > 0);
	assert.match(history.finalOutput, /^99/);
});

test("an oversized single assistant message becomes an explicit bounded preview", () => {
	const history = createHistory();
	history.append({ role: 'assistant', content: [{ type: 'text', text: 'answer ' + 'é'.repeat(HISTORY_BYTES) }] });
	assert.ok(Buffer.byteLength(JSON.stringify(history.messages)) <= HISTORY_BYTES);
	assert.ok(Buffer.byteLength(history.finalOutput) <= FINAL_BYTES);
	assert.match(history.finalOutput, /^answer /);
	assert.match(history.messages[0].content[0].text, /not retained/);
	assert.equal(history.stats.shortenedMessages, 1);
});

test("stderr retains a UTF-8-safe bounded tail with omission accounting", () => {
	const stderr = createStderrBuffer();
	stderr.write(Buffer.from('😀'.repeat(STDERR_BYTES)));
	const ending = Buffer.from('é end');
	for (const byte of ending) stderr.write(Buffer.from([byte]));
	stderr.end();
	assert.ok(Buffer.byteLength(stderr.text) <= STDERR_BYTES);
	assert.ok(stderr.omittedBytes > 0);
	assert.ok(stderr.text.endsWith('é end'));
	assert.doesNotMatch(stderr.text, /�/);
});

test("short output is preserved exactly", () => {
	assert.equal(truncateUtf8("hello 😀", 200), "hello 😀");
});

test("history final output concatenates all assistant text parts without separators", () => {
	const history = createHistory();
	history.append({ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'toolCall', id: '1', name: 'read', arguments: {} }, { type: 'text', text: 'b😀' }] });
	assert.equal(history.finalOutput, 'ab😀');
});

test("an explicitly empty latest assistant text replaces the earlier final output", () => {
	const history = createHistory();
	history.append({ role: 'assistant', content: [{ type: 'text', text: 'earlier' }] });
	history.append({ role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'text', text: '' }] });
	assert.equal(history.finalOutput, '');
});

test("answer presence uses original text rather than truncation notices", () => {
	const history = createHistory();
	assert.equal(history.hasFinalOutput, false);
	history.append({ role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] });
	assert.equal(history.hasFinalOutput, true);
	history.append({ role: 'assistant', content: [{ type: 'text', text: ' \t\n'.repeat(FINAL_BYTES) }] });
	assert.match(history.finalOutput, /Output truncated/);
	assert.equal(history.hasFinalOutput, false);

	history.append({ role: 'assistant', content: [{ type: 'text', text: ' '.repeat(FINAL_BYTES) }, { type: 'text', text: 'answer' }] });
	assert.equal(history.hasFinalOutput, true, 'non-whitespace beyond the preview still counts');

	history.append({ role: 'assistant', content: [{ type: 'text', text: '' }] });
	assert.equal(history.hasFinalOutput, false);
});

test("a textless assistant message clears answer presence but preserves its preview", () => {
	const history = createHistory();
	history.append({ role: 'assistant', content: [{ type: 'text', text: 'earlier narration' }] });
	history.append({ role: 'toolResult', content: [{ type: 'text', text: 'tool result' }] });
	assert.equal(history.hasFinalOutput, true, 'tool results do not change assistant answer presence');
	history.append({ role: 'assistant', content: [] });
	assert.equal(history.hasFinalOutput, false);
	assert.equal(history.finalOutput, 'earlier narration');
	history.append({ role: 'toolResult', content: [{ type: 'text', text: 'another result' }] });
	assert.equal(history.hasFinalOutput, false);
	history.append({ role: 'assistant', content: [{ type: 'text', text: 'actual answer' }] });
	assert.equal(history.hasFinalOutput, true);
});

test("combined text parts above the final cap get one UTF-8-safe notice", () => {
	const history = createHistory();
	history.append({ role: 'assistant', content: [{ type: 'text', text: 'é'.repeat(FINAL_BYTES / 2 - 10) }, { type: 'text', text: '😀'.repeat(100) }] });
	assert.ok(Buffer.byteLength(history.finalOutput) <= FINAL_BYTES);
	assert.equal(history.stats.finalOutputTruncated, true);
	assert.equal(history.finalOutput.match(/Output truncated/g).length, 1);
	assert.doesNotMatch(history.finalOutput, /�/);
});
