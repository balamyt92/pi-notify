/**
 * notify.ts — чистая логика уведомления.
 *
 * Никакого запуска процессов: только извлечение итога прогона, сборка env-полезной
 * нагрузки и решение, какие команды играть. Индекс (index.ts) подключает это к
 * событиям pi, exec.ts исполняет команды.
 *
 * Контракт: текст идёт в дочерний процесс ТОЛЬКО через env (PI_NOTIFY_*).
 * Команды из конфига читают их сами. Поэтому в buildCommands текст не
 * интерполируется — инъекция через сообщение невозможна.
 */

import { WSL_PASSTHROUGH_VARS, type NotifyConfig, type Outcome, type Platform } from "./config.ts";

/** Извлечённый из прогона итог: статус + человекочитаемое сообщение. */
export interface RunSummary {
	outcome: Outcome;
	/** Краткое сообщение для тела уведомления. */
	message: string;
}

/**
 * Итог по последнему assistant-сообщению.
 * stopReason: "aborted" → aborted, "error" → error, иначе completed.
 * Пустой список или отсутствие assistant-сообщения → completed (агент отработал).
 */
export function outcomeFromMessages(messages: readonly { role: string; stopReason?: string }[]): Outcome {
	let last: Outcome = "completed";
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		if (m.stopReason === "aborted") last = "aborted";
		else if (m.stopReason === "error") last = "error";
		else last = "completed";
	}
	return last;
}

/** Текст последнего assistant-сообщения (конкатенация text-блоков). */
export function lastAssistantText(
	messages: readonly { role: string; content?: unknown }[],
): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const content = m.content;
		if (typeof content === "string") return content.trim();
		if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const block of content) {
				if (
					block &&
					typeof block === "object" &&
					(block as { type?: unknown }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string"
				) {
					parts.push((block as { text: string }).text);
				}
			}
			const joined = parts.join("").trim();
			if (joined) return joined;
		}
		// У assistant нет текста (только tool-calls) — продолжаем поиск вверх.
	}
	return "";
}

/**
 * Собрать итог прогона: статус + сообщение.
 * Для error/aborted подставляет человекочитаемый текст, если модель его не дала.
 */
export function summarize(messages: readonly { role: string; stopReason?: string; content?: unknown }[]): RunSummary {
	const outcome = outcomeFromMessages(messages);
	let message = lastAssistantText(messages);
	if (!message) {
		if (outcome === "aborted") message = "Прервано пользователем";
		else if (outcome === "error") message = "Ошибка при выполнении";
		else message = "Готово";
	}
	// Ограничиваем тело: пуш-лимиты ОС маленькие, да и читать длинно.
	return { outcome, message: truncate(message, 200) };
}

/** Усечение с многоточием по символам (не по байтам). */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Нужен ли пуш при данных настройках: общий вкл, канал вкл, итог в списке,
 * длительность не ниже порога.
 */
export function shouldNotify(
	cfg: Pick<NotifyConfig, "enabled" | "notifyOn" | "minDurationSeconds">,
	outcome: Outcome,
	durationSeconds: number,
): boolean {
	if (!cfg.enabled) return false;
	if (!cfg.notifyOn.includes(outcome)) return false;
	if (durationSeconds < cfg.minDurationSeconds) return false;
	return true;
}

/**
 * Собрать WSLENV для проброса PI_NOTIFY_* из WSL в Windows.
 * Сохраняет уже заданные пользователем записи WSLENV, добавляя наши имена
 * без дублей. Без флагов значение передаётся как есть (без path-конвертации),
 * что нужно для произвольного текста.
 */
export function buildWslPassthrough(existing?: string): string {
	const parts = (existing ?? "").split(":").filter((s) => s.length > 0);
	for (const name of WSL_PASSTHROUGH_VARS) {
		// Имя в WSLENV может быть с флагами: "NAME/p". Сравниваем базовую часть.
		const base = parts.find((p) => p.split("/")[0] === name);
		if (!base) parts.push(name);
	}
	return parts.join(":");
}

/** Нагрузка для одного уведомления. */
export interface NotifyPayload {
	title: string;
	message: string;
	outcome: Outcome;
	durationSeconds: number;
	/** Разрешённый путь к звуку (уже Windows-UNC для WSL). */
	soundFile?: string;
	/** Длительность keep-alive плеера, мс. */
	soundDurationMs?: number;
	/** Громкость 0.0–1.0 (Windows/WSL). */
	volume?: number;
	/** Работаем из WSL — добавить WSLENV для проброса за границу interop. */
	wsl?: boolean;
	/** Уже заданный пользователем WSLENV (для сохранения при слиянии). */
	existingWslenv?: string;
}

/** Env-полезная нагрузка для дочерних процессов. */
export function buildEnv(p: NotifyPayload): Record<string, string> {
	const env: Record<string, string> = {
		PI_NOTIFY_TITLE: p.title,
		PI_NOTIFY_MESSAGE: p.message,
		PI_NOTIFY_OUTCOME: p.outcome,
		PI_NOTIFY_DURATION: String(Math.round(p.durationSeconds)),
	};
	if (p.soundFile) env.PI_NOTIFY_SOUND_FILE = p.soundFile;
	if (p.soundDurationMs != null) env.PI_NOTIFY_SOUND_DURATION = String(Math.round(p.soundDurationMs));
	if (p.volume != null) env.PI_NOTIFY_SOUND_VOLUME = String(p.volume);
	// В WSL env не пересекает границу interop, пока имя не объявлено в WSLENV.
	if (p.wsl) env.WSLENV = buildWslPassthrough(p.existingWslenv);
	return env;
}

/**
 * Команды для платформы по текущему каналу.
 * kind: "sound" | "push". Пустая/отсутствующая строка → null (канал не играть).
 */
export function commandFor(
	cfg: NotifyConfig,
	platform: Platform,
	kind: "sound" | "push",
): string | null {
	const cmd = cfg.commands[platform]?.[kind];
	if (typeof cmd !== "string") return null;
	const trimmed = cmd.trim();
	return trimmed.length > 0 ? cmd : null;
}

/**
 * Полный план: какие команды запустить для прогона.
 * Возвращает упорядоченный список (звук, затем пуш). Пустой — ничего не слать.
 * Учитывает флаги cfg.sound / cfg.push и наличие команды для платформы.
 */
export function buildPlan(
	cfg: NotifyConfig,
	platform: Platform,
): { sound: string | null; push: string | null } {
	const sound = cfg.sound ? commandFor(cfg, platform, "sound") : null;
	const push = cfg.push ? commandFor(cfg, platform, "push") : null;
	return { sound, push };
}
