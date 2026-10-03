/**
 * exec.ts — исполнение команд уведомления.
 *
 * Каждый канал (звук/пуш) запускается отдельным detached-процессом через shell,
 * чтобы:
 *   - не блокировать агентный цикл (уведомление не должно тормозить Pi);
 *   - позволить командам использовать shell-синтаксис (`||`, `$VAR`, пайпы);
 *   - не утаскивать уведомление за собой при выходе Pi (detached + unref).
 *
 * Ошибки проглатываются best-effort: отсутствующий notify-send или неверная
 * команда не должны ронять сессию. Диагностика — через onLog-колбэк.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export interface RunOptions {
	/** Env для дочернего процесса (поверх process.env). */
	env?: Record<string, string>;
	/** Колбэк диагностики: (канал, команда, ошибка?). */
	onLog?: (channel: string, command: string, error?: string) => void;
}

/**
 * Запустить одну команду best-effort. Никогда не бросает.
 * Возвращает true, если процесс удалось запустить (не равно «уведомление показано»).
 */
export function runCommand(
	channel: string,
	command: string,
	opts: RunOptions = {},
): boolean {
	if (!command || command.trim().length === 0) return false;
	try {
		const child = spawn(command, {
			shell: true,
			detached: true,
			stdio: "ignore",
			env: { ...process.env, ...(opts.env ?? {}) },
		});
		// Ошибки запуска (ENOENT и т.п.) приходят асинхронно — гасим их.
		child.on("error", (err) => {
			opts.onLog?.(channel, command, err instanceof Error ? err.message : String(err));
		});
		// Отвязываем от родительского процесса: Pi может выйти, уведомление — нет.
		child.unref();
		return true;
	} catch (err) {
		opts.onLog?.(channel, command, err instanceof Error ? err.message : String(err));
		return false;
	}
}

/** Результат дожидающегося запроса (в отличие от уведомительных — нам нужен код). */
export interface CaptureResult {
	/** Код возврата; null — процесс не запустился или убит сигналом. */
	code: number | null;
	signal: string | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}

/** Ограничение на объёт собираемого вывода, чтобы не растить память на болтливой команде. */
const MAX_CAPTURE = 4096;

/**
 * Запустить команду и дождаться её кода возврата. Никогда не бросает: ошибка
 * запуска и таймаут возвращаются в результате.
 *
 * В отличие от runCommand здесь НЕ detached и stdio собран: код возврата и есть
 * ответ (см. focusStateFromExitCode). Таймаут нужен, чтобы медленный или
 * зависший запрос фокуса не задерживал сигнал.
 */
export function runCapture(
	command: string,
	timeoutMs = 2000,
	opts: { env?: Record<string, string> } = {},
): Promise<CaptureResult> {
	const empty: CaptureResult = { code: null, signal: null, timedOut: false, stdout: "", stderr: "" };
	if (!command || command.trim().length === 0) return Promise.resolve(empty);
	return new Promise<CaptureResult>((resolve) => {
		let child: ChildProcessByStdio<null, Readable, Readable>;
		try {
			child = spawn(command, {
				shell: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: opts.env ? { ...process.env, ...opts.env } : process.env,
			});
		} catch (err) {
			resolve({ ...empty, stderr: err instanceof Error ? err.message : String(err) });
			return;
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {
				/* процесс уже мог завершиться */
			}
		}, timeoutMs);
		timer.unref?.();
		child.stdout.on("data", (d) => {
			if (stdout.length < MAX_CAPTURE) stdout += String(d);
		});
		child.stderr.on("data", (d) => {
			if (stderr.length < MAX_CAPTURE) stderr += String(d);
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ ...empty, timedOut, stdout: stdout.trim(), stderr: stderr.trim() || err.message });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal: signal ?? null, timedOut, stdout: stdout.trim(), stderr: stderr.trim() });
		});
	});
}

/**
 * Запустить план уведомления (звук + пуш). Каждый канал — отдельный процесс.
 * Возвращает список каналов, которые удалось запустить.
 */
export function runPlan(
	plan: { sound: string | null; push: string | null },
	opts: RunOptions = {},
): string[] {
	const started: string[] = [];
	if (plan.sound && runCommand("sound", plan.sound, opts)) started.push("sound");
	if (plan.push && runCommand("push", plan.push, opts)) started.push("push");
	return started;
}
