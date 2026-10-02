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

import { spawn } from "node:child_process";

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
