/**
 * Офлайн-тесты focus.ts: разбор потока stdin, приоритет источников,
 * разрешение кода возврата OS-запроса.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	attachFocusListener,
	chunkToString,
	createFocusTracker,
	focusStateFromExitCode,
	focusView,
	parseFocusChunk,
} from "../focus.ts";

// --- parseFocusChunk ----------------------------------------------------------

test("parseFocusChunk: одиночные ESC[I и ESC[O", () => {
	assert.deepEqual(parseFocusChunk("\x1b[I").events, ["focused"]);
	assert.deepEqual(parseFocusChunk("\x1b[O").events, ["unfocused"]);
});

test("parseFocusChunk: несколько событий в одном чанке, в порядке появления", () => {
	assert.deepEqual(parseFocusChunk("abc\x1b[Odef\x1b[I").events, ["unfocused", "focused"]);
});

test("parseFocusChunk: похожие последовательности игнорируются", () => {
	assert.deepEqual(parseFocusChunk("\x1b[A\x1b[Ix\x1b[1;2I\x1bO").events, ["focused"]);
});

test("parseFocusChunk: событие, разрезанное по чанкам, собирается через carry", () => {
	const first = parseFocusChunk("abc\x1b[");
	assert.deepEqual(first.events, []);
	assert.equal(first.carry, "\x1b[");
	const second = parseFocusChunk("O", first.carry);
	assert.deepEqual(second.events, ["unfocused"]);
});

test("parseFocusChunk: одиночный ESC в конце держится в carry, в середине — нет", () => {
	assert.equal(parseFocusChunk("x\x1b").carry, "\x1b");
	assert.equal(parseFocusChunk("\x1b[A").carry, "");
	assert.equal(parseFocusChunk("").carry, "");
});

test("parseFocusChunk: carry не накапливается на произвольном вводе", () => {
	const r = parseFocusChunk("много текста без последовательностей", "предыдущ");
	assert.deepEqual(r.events, []);
	assert.equal(r.carry, "");
});

test("chunkToString: строка, Buffer и Uint8Array", () => {
	assert.equal(chunkToString("\x1b[I"), "\x1b[I");
	assert.equal(chunkToString(Buffer.from("\x1b[O")), "\x1b[O");
	assert.equal(chunkToString(new Uint8Array([0x1b, 0x5b, 0x49])), "\x1b[I");
	assert.equal(chunkToString(undefined), "");
	assert.equal(chunkToString(42), "");
});

// --- focusView: приоритет источников -----------------------------------------

const base = { lastInputMs: 0, nowMs: 10_000, presenceWindowMs: 10_000 };

test("focusView: терминал авторитетен, включая «не в фокусе» при свежем вводе", () => {
	assert.deepEqual(focusView({ ...base, terminal: "unfocused", lastInputMs: 9_990 }), {
		state: "unfocused",
		source: "terminal",
	});
	assert.deepEqual(focusView({ ...base, terminal: "focused" }), {
		state: "focused",
		source: "terminal",
	});
});

test("focusView: без терминала решает свежий ввод", () => {
	assert.deepEqual(focusView({ ...base, terminal: null, lastInputMs: 1_000 }), {
		state: "focused",
		source: "presence",
	});
});

test("focusView: ввод старше окна присутствия не считается", () => {
	assert.deepEqual(focusView({ ...base, terminal: null, lastInputMs: 0, query: "unfocused" }), {
		state: "unfocused",
		source: "query",
	});
	assert.deepEqual(focusView({ ...base, terminal: null, lastInputMs: -1, query: null }), {
		state: "unknown",
		source: "none",
	});
});

test("focusView: OS-запрос используется только когда своих данных нет", () => {
	assert.deepEqual(focusView({ ...base, terminal: null, lastInputMs: 9_999, query: "unfocused" }), {
		state: "focused",
		source: "presence",
	});
});

// --- трекер -------------------------------------------------------------------

test("tracker: feed обновляет состояние терминала, view его отдаёт", () => {
	const t = createFocusTracker({ presenceWindowMs: 10_000 });
	assert.deepEqual(t.view(1000), { state: "unknown", source: "none" });
	assert.equal(t.feed(Buffer.from("\x1b[O")), 1);
	assert.equal(t.terminalState(), "unfocused");
	assert.deepEqual(t.view(1000), { state: "unfocused", source: "terminal" });
	assert.equal(t.feed("обычный ввод"), 0);
	assert.equal(t.terminalState(), "unfocused");
});

test("tracker: markInput помечает присутствие и переживает feed без событий", () => {
	const t = createFocusTracker({ presenceWindowMs: 5_000 });
	t.markInput(1_000);
	assert.deepEqual(t.view(4_000), { state: "focused", source: "presence" });
	assert.deepEqual(t.view(6_001), { state: "unknown", source: "none" });
	t.feed("x");
	assert.equal(t.lastInputMs(), 1_000);
});

test("tracker: resolveWith подставляет ответ OS-запроса поверх unknown", () => {
	const t = createFocusTracker();
	assert.deepEqual(t.resolveWith("unfocused"), { state: "unfocused", source: "query" });
	t.feed("\x1b[I");
	assert.deepEqual(t.resolveWith("unfocused"), { state: "focused", source: "terminal" });
});

test("attachFocusListener: не подписывается без TTY и без слушателя stdin", () => {
	const t = createFocusTracker();
	const fake = { isTTY: false, listenerCount: () => 1, on: () => {}, off: () => {} } as any;
	assert.equal(attachFocusListener(t, fake), null);

	const notRead = { isTTY: true, listenerCount: () => 0, on: () => {}, off: () => {} } as any;
	assert.equal(attachFocusListener(t, notRead), null);

	let attached: ((c: unknown) => void) | undefined;
	const read = {
		isTTY: true,
		listenerCount: () => 1,
		on: (_: string, cb: (c: unknown) => void) => {
			attached = cb;
		},
		off: () => {
			attached = undefined;
		},
	} as any;
	const detach = attachFocusListener(t, read);
	assert.equal(typeof detach, "function");
	attached?.("\x1b[O");
	assert.equal(t.terminalState(), "unfocused");
	detach?.();
	assert.equal(attached, undefined);
});

// --- код возврата OS-запроса -------------------------------------------------

test("focusStateFromExitCode: 0 → focused, 1 → unfocused, остальное → null", () => {
	const r = (over: Partial<import("../exec.ts").CaptureResult>) => ({
		code: 0,
		signal: null,
		timedOut: false,
		stdout: "",
		stderr: "",
		...over,
	});
	assert.equal(focusStateFromExitCode(r({ code: 0 })), "focused");
	assert.equal(focusStateFromExitCode(r({ code: 1 })), "unfocused");
	assert.equal(focusStateFromExitCode(r({ code: 2 })), null);
	assert.equal(focusStateFromExitCode(r({ code: null })), null);
	assert.equal(focusStateFromExitCode(r({ code: 0, timedOut: true })), null);
});
