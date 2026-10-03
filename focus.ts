/**
 * focus.ts — определение присутствия: смотрит ли человек на TUI.
 *
 * Источники (по убыванию авторитетности):
 *   1. События фокуса терминала DECSET 1004 — `ESC[I` (фокус пришёл) и
 *      `ESC[O` (ушёл). Pi включает `?1004h` вместе с мышиными последовательностями
 *      и получает эти байты на stdin. Расширение читает тот же поток вторым
 *      слушателем: Node отдаёт один чанк всем `data`-слушателям, поэтому TUI
 *      ничего не теряет.
 *   2. Косвенный признак присутствия: сообщение пользователя (`input`-событие с
 *      source "interactive") означает, что человек только что был у клавиатуры.
 *      Нужно там, где терминал фокус не сообщает (нет 1004), и работает как
 *      «активен последние N секунд».
 *   3. Запрос активного окна ОС (`commands[platform].focus`). Только когда
 *      первых двух не хватило. Код возврата: 0 — терминал в фокусе, 1 — нет,
 *      2 или таймаут/ошибка — неизвестно.
 *
 * Нет данных = «считаем, что смотрит» (решение пользователя): короткие прогоны
 * при неизвестном фокусе не сигналят, длинные — сигналят.
 *
 * Чистые функции (parseFocusChunk, focusView, focusStateFromExitCode) не трогают
 * ни процессов, ни stdin — тестируются офлайн.
 */

import type { CaptureResult } from "./exec.ts";

/** Состояние фокуса TUI. `unknown` — ни один источник не ответил. */
export type FocusState = "focused" | "unfocused" | "unknown";

/** Что дало ответ: терминальные события, факт ввода, OS-запрос или ничего. */
export type FocusSource = "terminal" | "presence" | "query" | "none";

export interface FocusView {
	state: FocusState;
	source: FocusSource;
}

/** Последовательности DECSET 1004, которые шлёт терминал. */
export const FOCUS_IN_SEQ = "\x1b[I";
export const FOCUS_OUT_SEQ = "\x1b[O";

/**
 * Разобрать поток stdin на события фокуса.
 *
 * `carry` — хвост предыдущего чанка, который мог быть началом последовательности
 * (`ESC` или `ESC[`), но оборвался. Возвращает найденные состояния и новый carry.
 * Скан по всему чанку, а не только по началу: терминал может прислать событие
 * в одном пакете с нажатиями клавиш.
 */
export function parseFocusChunk(
	data: string,
	carry = "",
): { events: FocusState[]; carry: string } {
	const s = carry + data;
	const events: FocusState[] = [];
	for (let i = 0; i < s.length; i++) {
		if (s.charCodeAt(i) !== 0x1b) continue;
		if (s.charCodeAt(i + 1) !== 0x5b) continue; // "["
		const c = s.charAt(i + 2);
		if (c === "I") events.push("focused");
		else if (c === "O") events.push("unfocused");
		if (c === "I" || c === "O") i += 2;
	}
	// Carry держим только за реальным началом последовательности в конце строки.
	let cut = s.length;
	if (s.endsWith("\x1b")) cut = s.length - 1;
	else if (s.endsWith("\x1b[")) cut = s.length - 2;
	return { events, carry: s.slice(cut) };
}

/** Нормализовать чанк stdin: TUI может вызвать setEncoding, тогда приходит строка. */
export function chunkToString(chunk: unknown): string {
	if (typeof chunk === "string") return chunk;
	if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
	if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
	return "";
}

export interface FocusTracker {
	/** Ответ терминала (ESC[I/ESC[O) или null, если событий не было. */
	terminalState(): FocusState | null;
	/** Метка «пользователь только что печатал». */
	markInput(nowMs?: number): void;
	/** Скормить чанк stdin; возвращает число найденных событий фокуса. */
	feed(chunk: unknown): number;
	/** Ответ по терминалу и присутствию, без OS-запроса. */
	view(nowMs?: number): FocusView;
	/** Полное разрешение с OS-запросом, когда своих данных нет. */
	resolveWith(query: FocusState | null): FocusView;
	lastInputMs(): number;
}

export interface FocusTrackerOptions {
	/** Сколько секунд после ввода считать человека активным. */
	presenceWindowMs?: number;
}

/**
 * Разрешить состояние по приоритету: терминал > присутствие > запрос > unknown.
 * Чистая функция — весь порядок решения живёт здесь, трекер только хранит данные.
 */
export function focusView(args: {
	terminal: FocusState | null;
	lastInputMs: number;
	nowMs: number;
	presenceWindowMs: number;
	query?: FocusState | null;
}): FocusView {
	if (args.terminal) return { state: args.terminal, source: "terminal" };
	if (
		args.lastInputMs > 0 &&
		args.nowMs - args.lastInputMs <= args.presenceWindowMs
	) {
		return { state: "focused", source: "presence" };
	}
	if (args.query) return { state: args.query, source: "query" };
	return { state: "unknown", source: "none" };
}

export function createFocusTracker(opts: FocusTrackerOptions = {}): FocusTracker {
	const presenceWindowMs = opts.presenceWindowMs ?? 10_000;
	let terminal: FocusState | null = null;
	let lastInputMs = 0;
	let carry = "";

	return {
		terminalState: () => terminal,
		markInput(nowMs = Date.now()) {
			lastInputMs = nowMs;
		},
		feed(chunk: unknown): number {
			const parsed = parseFocusChunk(chunkToString(chunk), carry);
			carry = parsed.carry;
			for (const ev of parsed.events) terminal = ev;
			return parsed.events.length;
		},
		view(nowMs = Date.now()): FocusView {
			return focusView({ terminal, lastInputMs, nowMs, presenceWindowMs });
		},
		resolveWith(query: FocusState | null): FocusView {
			return focusView({ terminal, lastInputMs, nowMs: Date.now(), presenceWindowMs, query });
		},
		lastInputMs: () => lastInputMs,
	};
}

/**
 * Подписаться на stdin и кормить трекер.
 *
 * Условие подключения: TTY и уже висящий `data`-слушатель. Второе означает, что
 * поток читает TUI — мы только подсоединяемся к чужому потоку и ничего не
 * «будим». В тестах и в печатном режиме слушателя нет, подписка не ставится.
 *
 * Возвращает отписку либо null, если условие не выполнено и подписаться не
 * удалось — тогда вызывающий может попробовать позже.
 */
export function attachFocusListener(
	tracker: FocusTracker,
	stream: NodeJS.ReadStream = process.stdin,
): (() => void) | null {
	if (!stream.isTTY) return null;
	if (stream.listenerCount("data") === 0) return null;
	const onData = (chunk: unknown) => {
		try {
			tracker.feed(chunk);
		} catch {
			// Ошибка разбора не должна влиять на ввод TUI.
		}
	};
	stream.on("data", onData);
	return () => stream.off("data", onData);
}

/**
 * Состояние фокуса по коду возврата OS-запроса.
 * 0 — в фокусе, 1 — не в фокусе, всё остальное (2+, сигнал, таймаут) — неизвестно.
 */
export function focusStateFromExitCode(res: CaptureResult): FocusState | null {
	if (res.timedOut || res.code === null) return null;
	if (res.code === 0) return "focused";
	if (res.code === 1) return "unfocused";
	return null;
}
