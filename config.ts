/**
 * config.ts — загрузка конфигурации pi-notify.
 *
 * Приоритет (сверху вниз, более высокое перебивает):
 *   1. Файл `~/.pi/agent/notify.json`
 *   2. Переменные окружения (PI_NOTIFY_*)
 *   3. Встроенные значения по умолчанию
 *
 * Файл живёт в agent-директории, а не внутри пакета: он пер-машинный и не
 * затирается при `pi update`. Чистые функции слияния (mergeConfig,
 * applyEnvOverrides, normalizeCommands) не трогают ФС — тестируются офлайн.
 *
 * Контракт безопасности: текст уведомления НИКОГДА не интерполируется в
 * shell-команду. Он передаётся дочернему процессу через env-переменные
 * PI_NOTIFY_TITLE / PI_NOTIFY_MESSAGE / PI_NOTIFY_OUTCOME / PI_NOTIFY_DURATION.
 * Команды читают их сами (osascript `system attribute`, PowerShell `$env:`,
 * shell `"$VAR"`). Поэтому произвольный текст не может сломать кавычки или
 * инжектить команды.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Outcome = "completed" | "aborted" | "error";
/**
 * Платформы. `wsl` — Linux-ядро WSL, где нативных аудио/нотификаций нет, и
 * пуш/звук направляются в Windows через interop (`powershell.exe`). Node внутри
 * WSL сообщает `process.platform === "linux"`, поэтому WSL определяется
 * отдельно (см. isWsl) и получает собственный набор команд.
 */
export type Platform = "darwin" | "win32" | "linux" | "wsl";

/** Команды одного канала (звук или пуш) для одной платформы. */
export interface CommandSet {
	sound?: string;
	push?: string;
}

export interface NotifyConfig {
	/** Общий выключатель. `false` — не слать ничего. */
	enabled: boolean;
	/** Играть канал звука. */
	sound: boolean;
	/** Играть канал пуша. */
	push: boolean;
	/** Не слать, если прогон короче этого порога (сек). 0 = всегда. */
	minDurationSeconds: number;
	/** Какие итоги порождают уведомление. */
	notifyOn: Outcome[];
	/** Заголовок уведомления. */
	title: string;
	/**
	 * Файл звука. `null`/пусто → встроенный asset `assets/notify.mp3`.
	 * Можно задать свой путь (WSL или Windows). В WSL путь конвертируется в UNC,
	 * чтобы powershell.exe его прочитал.
	 */
	soundFile: string | null;
	/**
	 * Сколько держать плеер живым для проигрывания (мс). Фиксированный сон —
	 * событие MediaEnded в Windows PowerShell 5.1 не отдаётся. Должно покрывать
	 * длительность файла с запасом.
	 */
	soundDurationMs: number;
	/**
	 * Громкость звука, 0.0–1.0 (WinRT MediaPlayer.Volume, линейная).
	 * Только Windows/WSL; на macOS/Linux громкость — на стороне проигрывателя.
	 */
	volume: number;
	/** Команды по платформам. Переопределяют встроенные дефолты. */
	commands: Record<Platform, CommandSet>;
}

export const CONFIG_FILENAME = "notify.json";

const ALL_OUTCOMES: Outcome[] = ["completed", "aborted", "error"];

/**
 * PowerShell для пуша Windows (WinRT toast). Читает env-переменные напрямую —
 * без интерполяции текста в командную строку. Кодируется в -EncodedCommand
 * (UTF-16LE base64), чтобы избежать проблем с кавычками при запуске.
 */
const WIN_TOAST_PS = [
	"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null",
	"$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
	"$n = $t.GetElementsByTagName('text')",
	"$n.Item(0).AppendChild($t.CreateTextNode($env:PI_NOTIFY_TITLE)) | Out-Null",
	"$n.Item(1).AppendChild($t.CreateTextNode($env:PI_NOTIFY_MESSAGE)) | Out-Null",
	"$toast = [Windows.UI.Notifications.ToastNotification]::new($t)",
	"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pi').Show($toast)",
].join("; ");

/**
 * PowerShell для звука Windows/WSL: играет MP3 через WinRT MediaPlayer.
 * Путь файла — из env `PI_NOTIFY_SOUND_FILE`, длительность сна keep-alive —
 * из `PI_NOTIFY_SOUND_DURATION`. Многострочный (base64 сохраняет переводы),
 * чтобы блоки `if` парсились корректно.
 */
const WIN_MP3_PS = [
	"[Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType=WindowsRuntime] | Out-Null",
	"[Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType=WindowsRuntime] | Out-Null",
	"$f = $env:PI_NOTIFY_SOUND_FILE",
	"if ($f) {",
	"  $mp = [Windows.Media.Playback.MediaPlayer]::new()",
	"  $mp.Source = [Windows.Media.Core.MediaSource]::CreateFromUri([Uri]::new($f))",
	"  $v = 0.4",
	"  if ($env:PI_NOTIFY_SOUND_VOLUME) { $v = [double]$env:PI_NOTIFY_SOUND_VOLUME }",
	"  $mp.Volume = $v",
	"  $mp.Play()",
	"  $d = 5000",
	"  if ($env:PI_NOTIFY_SOUND_DURATION) { $d = [int]$env:PI_NOTIFY_SOUND_DURATION }",
	"  Start-Sleep -Milliseconds $d",
	"  $mp.Dispose()",
	"}",
].join("\n");

/** Кодирование PowerShell-скрипта в аргумент -EncodedCommand. */
export function psEncode(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Переменные, которые в WSL нужно экспортировать в Windows через WSLENV,
 * чтобы дочерний powershell.exe их увидел. Без WSLENV WSL не передаёт
 * произвольные Linux-переменные за границу interop.
 */
export const WSL_PASSTHROUGH_VARS = [
	"PI_NOTIFY_TITLE",
	"PI_NOTIFY_MESSAGE",
	"PI_NOTIFY_OUTCOME",
	"PI_NOTIFY_DURATION",
	"PI_NOTIFY_SOUND_FILE",
	"PI_NOTIFY_SOUND_DURATION",
	"PI_NOTIFY_SOUND_VOLUME",
] as const;

/** Встроенные команды по умолчанию для всех платформ. */
export const DEFAULT_COMMANDS: Record<Platform, CommandSet> = {
	darwin: {
		sound: "afplay /System/Library/Sounds/Glass.aiff",
		push:
			'osascript -e \'display notification (system attribute "PI_NOTIFY_MESSAGE") with title (system attribute "PI_NOTIFY_TITLE")\'',
	},
	win32: {
		sound: `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncode(WIN_MP3_PS)}`,
		push: `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncode(WIN_TOAST_PS)}`,
	},
	// WSL: тот же Windows-тост/звук, но через `powershell.exe` (interop-имя).
	// Текст и путь к звуку доходят через env + WSLENV (см. buildEnv в notify.ts).
	wsl: {
		sound: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${psEncode(WIN_MP3_PS)}`,
		push: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${psEncode(WIN_TOAST_PS)}`,
	},
	linux: {
		// Пакетный набор: пробуем PulseAudio, потом ALSA, потом молча пропускаем.
		sound:
			"paplay /usr/share/sounds/freedesktop/stereo/complete.oga 2>/dev/null || aplay /usr/share/sounds/alsa/Complete.oga 2>/dev/null || true",
		push: 'notify-send "$PI_NOTIFY_TITLE" "$PI_NOTIFY_MESSAGE"',
	},
};

export const DEFAULT_CONFIG: NotifyConfig = {
	enabled: true,
	sound: true,
	push: true,
	minDurationSeconds: 0,
	notifyOn: [...ALL_OUTCOMES],
	title: "Pi",
	soundFile: null,
	soundDurationMs: 5000,
	volume: 0.4,
	commands: structuredClone(DEFAULT_COMMANDS),
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlatform(value: string): value is Platform {
	return value === "darwin" || value === "win32" || value === "linux" || value === "wsl";
}

/** Нормализация списка итогов: только валидные, без дублей, не пустой. */
export function normalizeNotifyOn(value: unknown, fallback: Outcome[]): Outcome[] {
	if (!Array.isArray(value)) return [...fallback];
	const seen = new Set<Outcome>();
	for (const entry of value) {
		if (entry === "completed" || entry === "aborted" || entry === "error") {
			seen.add(entry);
		}
	}
	if (seen.size === 0) return [...fallback];
	return [...seen];
}

/**
 * Слияние набора команд: пользовательские поля поверх дефолтов, по платформам.
 * Неизвестная платформа или канал игнорируются. Пустая строка = «канал выключен»
 * (в buildCommands такая команда не возвращается).
 */
export function mergeCommands(value: unknown, defaults: Record<Platform, CommandSet>): Record<Platform, CommandSet> {
	const out: Record<Platform, CommandSet> = structuredClone(defaults);
	if (!isRecord(value)) return out;
	for (const [plat, set] of Object.entries(value)) {
		if (!isPlatform(plat) || !isRecord(set)) continue;
		const sound = set.sound;
		const push = set.push;
		if (typeof sound === "string") out[plat].sound = sound;
		if (typeof push === "string") out[plat].push = push;
	}
	return out;
}

/** Слияние объекта из файла с дефолтами. Поля файла имеют приоритет. */
export function mergeConfig(fileObj: unknown, defaults: NotifyConfig): NotifyConfig {
	if (!isRecord(fileObj)) {
		throw new Error("config file must contain a JSON object");
	}
	return {
		enabled: typeof fileObj.enabled === "boolean" ? fileObj.enabled : defaults.enabled,
		sound: typeof fileObj.sound === "boolean" ? fileObj.sound : defaults.sound,
		push: typeof fileObj.push === "boolean" ? fileObj.push : defaults.push,
		minDurationSeconds:
			typeof fileObj.minDurationSeconds === "number" && fileObj.minDurationSeconds >= 0
				? fileObj.minDurationSeconds
				: defaults.minDurationSeconds,
		notifyOn: normalizeNotifyOn(fileObj.notifyOn, defaults.notifyOn),
		title: typeof fileObj.title === "string" && fileObj.title.length > 0 ? fileObj.title : defaults.title,
		soundFile:
			typeof fileObj.soundFile === "string" && fileObj.soundFile.length > 0
				? fileObj.soundFile
				: defaults.soundFile,
		soundDurationMs:
			typeof fileObj.soundDurationMs === "number" && fileObj.soundDurationMs >= 0
				? fileObj.soundDurationMs
				: defaults.soundDurationMs,
		volume: clampVolume(fileObj.volume, defaults.volume),
		commands: mergeCommands(fileObj.commands, defaults.commands),
	};
}

function boolFromEnv(v: string | undefined, current: boolean): boolean {
	if (v === "1" || v === "true") return true;
	if (v === "0" || v === "false") return false;
	return current;
}

/** Кламп громкости в [0,1]; невалидное значение → fallback. */
export function clampVolume(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(1, Math.max(0, value));
}

/** Переопределение полей окружением (поверх файла). */
export function applyEnvOverrides(
	cfg: NotifyConfig,
	env: Record<string, string | undefined>,
): NotifyConfig {
	const out: NotifyConfig = {
		...cfg,
		notifyOn: [...cfg.notifyOn],
		commands: structuredClone(cfg.commands),
	};
	out.enabled = boolFromEnv(env.PI_NOTIFY, out.enabled);
	out.sound = boolFromEnv(env.PI_NOTIFY_SOUND, out.sound);
	out.push = boolFromEnv(env.PI_NOTIFY_PUSH, out.push);
	if (env.PI_NOTIFY_TITLE && env.PI_NOTIFY_TITLE.length > 0) out.title = env.PI_NOTIFY_TITLE;
	if (env.PI_NOTIFY_SOUND_FILE && env.PI_NOTIFY_SOUND_FILE.length > 0) out.soundFile = env.PI_NOTIFY_SOUND_FILE;
	if (env.PI_NOTIFY_SOUND_DURATION) {
		const n = Number(env.PI_NOTIFY_SOUND_DURATION);
		if (Number.isFinite(n) && n >= 0) out.soundDurationMs = n;
	}
	if (env.PI_NOTIFY_VOLUME) {
		const n = Number(env.PI_NOTIFY_VOLUME);
		if (Number.isFinite(n)) out.volume = clampVolume(n, out.volume);
	}
	if (env.PI_NOTIFY_MIN_DURATION) {
		const n = Number(env.PI_NOTIFY_MIN_DURATION);
		if (Number.isFinite(n) && n >= 0) out.minDurationSeconds = n;
	}
	// Переопределение команд текущей платформы: PI_NOTIFY_CMD_SOUND / PI_NOTIFY_CMD_PUSH.
	const plat = currentPlatform();
	if (env.PI_NOTIFY_CMD_SOUND) out.commands[plat] = { ...out.commands[plat], sound: env.PI_NOTIFY_CMD_SOUND };
	if (env.PI_NOTIFY_CMD_PUSH) out.commands[plat] = { ...out.commands[plat], push: env.PI_NOTIFY_CMD_PUSH };
	return out;
}

/**
 * Признак WSL по окружению. WSL задаёт WSL_DISTRO_NAME и WSL_INTEROP в любом
 * дистрибутиве. Чистая функция от env — тестируется офлайн.
 */
export function isWsl(env: Record<string, string | undefined> = process.env): boolean {
	return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

/**
 * Платформа по умолчанию из process.platform с поправкой на WSL:
 * Linux-ядро + признаки WSL → "wsl" (бить в Windows, не в нативный Linux).
 */
export function currentPlatform(env: Record<string, string | undefined> = process.env): Platform {
	const p = process.platform;
	if (p === "darwin") return "darwin";
	if (p === "win32") return "win32";
	if (isWsl(env)) return "wsl";
	return "linux";
}

/** Путь к встроенному звуку пакета: `assets/notify.mp3` рядом с модулем. */
export function bundledSoundPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "assets", "notify.mp3");
}

/**
 * Конвертация WSL-пути в Windows UNC `\\wsl.localhost\<distro>\...`.
 * Уже windows-путь (диск `C:\` или UNC `\\`) возвращается как есть.
 * Чистая функция от (путь, дистрибутив) — тестируется офлайн.
 */
export function wslPathToWindows(p: string, distro: string): string {
	if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")) return p;
	const rel = p.replace(/^\/+/, "").replace(/\//g, "\\");
	return `\\\\wsl.localhost\\${distro}\\${rel}`;
}

/**
 * Разрешить файл звука: override из конфига либо встроенный asset.
 * В WSL путь конвертируется в Windows UNC, чтобы powershell.exe прочитал его.
 * На других платформах — как есть.
 */
export function resolveSoundFile(
	cfg: Pick<NotifyConfig, "soundFile">,
	platform: Platform,
	env: Record<string, string | undefined> = process.env,
): string {
	const raw = cfg.soundFile && cfg.soundFile.length > 0 ? cfg.soundFile : bundledSoundPath();
	if (platform === "wsl") {
		const distro = env.WSL_DISTRO_NAME ?? "Ubuntu";
		return wslPathToWindows(raw, distro);
	}
	return raw;
}

/** Путь к пользовательскому конфигу. */
export function configPath(): string {
	return join(getAgentDir(), CONFIG_FILENAME);
}

/**
 * Итоговая загрузка: файл (если есть) → env → дефолты.
 * Отсутствующий файл — не ошибка, работают дефолты. Невалидный JSON — явная ошибка.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): NotifyConfig {
	const path = configPath();
	if (!existsSync(path)) {
		return applyEnvOverrides(DEFAULT_CONFIG, env);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(
			`pi-notify: invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return applyEnvOverrides(mergeConfig(parsed, DEFAULT_CONFIG), env);
}
