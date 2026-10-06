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
 * Текст вопроса идёт теми же переменными; PI_NOTIFY_KIND различает итог прогона
 * ("run") и ожидающий ответа вопрос ("question").
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
 * отдельно (см. isWsl, wslFromProcVersion) и получает собственный набор команд.
 *
 * Одних переменных окружения мало: `WSL_DISTRO_NAME`/`WSL_INTEROP` отсутствуют в
 * окружении, которое их не экспортирует (tmux без `update-environment`, systemd,
 * cron, harness-обёртки). Тогда остаётся признак ядра в `/proc/version` — он не
 * зависит от окружения процесса.
 */
export type Platform = "darwin" | "win32" | "linux" | "wsl";

/** Команды одного канала (звук, пуш или запрос фокуса) для одной платформы. */
export interface CommandSet {
	sound?: string;
	push?: string;
	/**
	 * Запрос «в фокусе ли терминал». Код возврата: 0 — в фокусе, 1 — нет,
	 * 2 или любая ошибка — неизвестно. Используется только когда терминал
	 * не прислал событий фокуса (DECSET 1004).
	 */
	focus?: string;
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
	 * Нотифицировать о вопросе агента (инструмент ask_user_question ждёт ответа).
	 * Вопрос не подчиняется `notifyOn` и `minDurationSeconds`: агент заблокирован
	 * до ответа человека, граница settle по нему не наступит никогда.
	 */
	onQuestion: boolean;
	/** Заголовок уведомления о вопросе. Отдельный от `title`, чтобы отличать в пуше. */
	questionTitle: string;
	/**
	 * Нотифицировать только из сессии с UI (`ctx.hasUI`).
	 *
	 * Фоновый сабагент поднимает собственный рантайм расширений через
	 * `createAgentSession` + `bindExtensions` без `uiContext`, поэтому его
	 * `ctx.hasUI === false`, а у интерактивной сессии — true. Без этого флага
	 * каждый сабагент шлёт собственный `agent_settled`-пуш: на N агентов N тостов.
	 *
	 * `false` возвращает прежнее поведение: печатать и из headless-сессий
	 * (`pi -p`, сабагенты). Печатный режим и без UI, так что там сигнал вернётся
	 * только этим флагом.
	 */
	requireUI: boolean;
	/**
	 * Сигналить только когда TUI не в фокусе.
	 *
	 * `true` (по умолчанию): в фокусе сигнал молчит, пока прогон короче
	 * `focusedGraceSeconds`; вне фокуса сигналит сразу. Без данных о фокусе
	 * состояние трактуется как «в фокусе» — короткие прогоны молчат.
	 *
	 * `false` — прежнее поведение: фокус не учитывается вовсе, слушатель stdin
	 * и OS-запросы не поднимаются.
	 */
	onlyWhenUnfocused: boolean;
	/**
	 * Порог (сек): если прогон не короче него, сигнал уходит даже при фокусе.
	 * Смысл — долгий ответ догнать звуком, а короткий не дублировать.
	 */
	focusedGraceSeconds: number;
	/**
	 * Сколько секунд после сообщения человека считать его у клавиатуры.
	 * Косвенный признак для терминалов без DECSET 1004: нажал Enter — значит смотрел.
	 */
	presenceWindowSeconds: number;
	/**
	 * Опрашивать активное окно ОС, когда терминал и ввод не ответили.
	 * Точнее, но это отдельный процесс (в WSL — powershell.exe, ~0.5 с).
	 */
	focusFallback: boolean;
	/** Таймаут OS-запроса фокуса, мс. Таймаут — состояние «неизвестно».
	 */
	focusQueryTimeoutMs: number;
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
	// Записи потока progress в неинтерактивном PowerShell уходят в stderr как
	// CLIXML. Для тоста они мусор, а в логах выглядят как ошибка.
	"$ProgressPreference = 'SilentlyContinue'",
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
	"$ProgressPreference = 'SilentlyContinue'",
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
	"PI_NOTIFY_KIND",
	"PI_NOTIFY_SOUND_FILE",
	"PI_NOTIFY_SOUND_DURATION",
	"PI_NOTIFY_SOUND_VOLUME",
] as const;

/**
 * Имя для запроса фокуса: список имён процессов-терминалов поверх встроенного.
 * Пробрасывается в Windows только для команды `commands.focus`, поэтому не входит
 * в WSL_PASSTHROUGH_VARS: без объявления в WSLENV переменная границу interop
 * не пересекает и PowerShell её не увидел бы.
 */
export const FOCUS_PASSTHROUGH_VAR = "PI_NOTIFY_FOCUS_PROCESSES";

/**
 * PowerShell-запрос активного окна: имя процесса foreground-окна сверяется со
 * списком терминалов. Код 0 — терминал активен, 1 — активен другой процесс,
 * 2 — определить не удалось.
 *
 * Список расширяется из `TERM_PROGRAM` и env `PI_NOTIFY_FOCUS_PROCESSES`
 * (список имён через запятую; в WSL такую переменную надо объявить в WSLENV).
 * Свой терминал с нестандартным именем задаётся переопределением `commands.focus`.
 */
const WIN_FOCUS_PS = [
	"$ProgressPreference = 'SilentlyContinue'",
	'Add-Type -Namespace PiNotify -Name FgWin -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint procId);\' | Out-Null',
	"$h = [PiNotify.FgWin]::GetForegroundWindow()",
	"$procId = [uint32]0",
	"[void][PiNotify.FgWin]::GetWindowThreadProcessId($h, [ref]$procId)",
	"$name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName",
	"if (-not $name) { exit 2 }",
	"$known = @('wezterm-gui','WindowsTerminal','WindowsTerminalPreview','ConEmu','ConEmu64','Alacritty','mintty','Tabby','Hyper','PuTTY','cmder','Code','cursor','Warp','kitty','ghostty','rio')",
	"if ($env:TERM_PROGRAM -eq 'WezTerm') { $known += 'wezterm-gui' }",
	"if ($env:TERM_PROGRAM -eq 'vscode') { $known += 'Code' }",
	"if ($env:PI_NOTIFY_FOCUS_PROCESSES) { $known += ($env:PI_NOTIFY_FOCUS_PROCESSES -split ',') }",
	"if ($known -contains $name) { exit 0 }",
	"exit 1",
].join("\n");

/**
 * X11: активное окно → его pid → проверка, есть ли он среди предков нашего
 * процесса (терминал всегда родитель оболочки). Нет xdotool или нет X — код 2.
 * Wayland так не определяется: там xdotool не отвечает, и остаётся 1004.
 */
const LINUX_FOCUS_SH =
	"pid=$(xdotool getactivewindow getwindowpid 2>/dev/null); [ -n \"$pid\" ] || exit 2; " +
	"p=$$; while [ -n \"$p\" ] && [ \"$p\" -gt 0 ]; do [ \"$p\" = \"$pid\" ] && exit 0; " +
	"p=$(sed -n 's/^PPid:[[:space:]]*\\([0-9]*\\).*/\\1/p' /proc/\"$p\"/status 2>/dev/null); done; " +
	"[ -n \"$p\" ] || exit 2; exit 1";

/**
 * macOS: имя frontmost-приложения из System Events, сверяется со списком
 * терминалов и с именами предков процесса. osascript недоступен — код 2.
 */
const DARWIN_FOCUS_SH =
	"front=$(osascript -e 'tell application \"System Events\" to get name of first application process whose frontmost is true' 2>/dev/null); " +
	'[ -n "$front" ] || exit 2; ' +
	'case "$front" in Terminal|iTerm2|iTerm|WezTerm|kitty|Alacritty|Warp|Hyper|Ghostty|Code|Cursor) exit 0;; esac; ' +
	"p=$$; while [ -n \"$p\" ] && [ \"$p\" -gt 0 ]; do c=$(ps -o comm= -p \"$p\" 2>/dev/null); " +
	'case "$c" in *"$front"*) exit 0;; esac; p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d \' \'); done; exit 1';

/**
 * Запуск PowerShell из WSL.
 *
 * Interop-имя `powershell.exe` резолвится только когда Windows-`PATH` дошёл до
 * Linux-`PATH`. В урезанном окружении (сервис, cron, обёртка без Windows-каталогов)
 * не доходит, и голое имя даёт «command not found». Поэтому сначала абсолютный
 * путь, голое имя — запасной вариант. Строка подставляется в начало команды и
 * исполняется тем же `sh -c`, что и команда канала.
 */
export const WSL_PS =
	"ps='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'; " +
	'[ -x "$ps" ] || ps=powershell.exe; "$ps"';

/** Встроенные команды по умолчанию для всех платформ. */
export const DEFAULT_COMMANDS: Record<Platform, CommandSet> = {
	darwin: {
		sound: "afplay /System/Library/Sounds/Glass.aiff",
		push:
			'osascript -e \'display notification (system attribute "PI_NOTIFY_MESSAGE") with title (system attribute "PI_NOTIFY_TITLE")\'',
		focus: DARWIN_FOCUS_SH,
	},
	win32: {
		sound: `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncode(WIN_MP3_PS)}`,
		push: `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncode(WIN_TOAST_PS)}`,
		focus: `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncode(WIN_FOCUS_PS)}`,
	},
	// WSL: тот же Windows-тост/звук, но через `powershell.exe` (interop-имя,
	// см. WSL_PS). Текст и путь к звуку доходят через env + WSLENV (buildEnv в notify.ts).
	wsl: {
		sound: `${WSL_PS} -NoProfile -NonInteractive -EncodedCommand ${psEncode(WIN_MP3_PS)}`,
		push: `${WSL_PS} -NoProfile -NonInteractive -EncodedCommand ${psEncode(WIN_TOAST_PS)}`,
		focus: `${WSL_PS} -NoProfile -NonInteractive -EncodedCommand ${psEncode(WIN_FOCUS_PS)}`,
	},
	linux: {
		// Пакетный набор: пробуем PulseAudio, потом ALSA, потом молча пропускаем.
		sound:
			"paplay /usr/share/sounds/freedesktop/stereo/complete.oga 2>/dev/null || aplay /usr/share/sounds/alsa/Complete.oga 2>/dev/null || true",
		push: 'notify-send "$PI_NOTIFY_TITLE" "$PI_NOTIFY_MESSAGE"',
		focus: LINUX_FOCUS_SH,
	},
};

export const DEFAULT_CONFIG: NotifyConfig = {
	enabled: true,
	sound: true,
	push: true,
	minDurationSeconds: 0,
	notifyOn: [...ALL_OUTCOMES],
	title: "Pi",
	onQuestion: true,
	questionTitle: "Pi: вопрос",
	requireUI: true,
	onlyWhenUnfocused: true,
	focusedGraceSeconds: 60,
	presenceWindowSeconds: 10,
	focusFallback: true,
	focusQueryTimeoutMs: 2000,
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
		const focus = set.focus;
		if (typeof sound === "string") out[plat].sound = sound;
		if (typeof push === "string") out[plat].push = push;
		if (typeof focus === "string") out[plat].focus = focus;
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
		onQuestion: typeof fileObj.onQuestion === "boolean" ? fileObj.onQuestion : defaults.onQuestion,
		questionTitle:
			typeof fileObj.questionTitle === "string" && fileObj.questionTitle.length > 0
				? fileObj.questionTitle
				: defaults.questionTitle,
		requireUI: typeof fileObj.requireUI === "boolean" ? fileObj.requireUI : defaults.requireUI,
		onlyWhenUnfocused:
			typeof fileObj.onlyWhenUnfocused === "boolean" ? fileObj.onlyWhenUnfocused : defaults.onlyWhenUnfocused,
		focusedGraceSeconds:
			typeof fileObj.focusedGraceSeconds === "number" && fileObj.focusedGraceSeconds >= 0
				? fileObj.focusedGraceSeconds
				: defaults.focusedGraceSeconds,
		presenceWindowSeconds:
			typeof fileObj.presenceWindowSeconds === "number" && fileObj.presenceWindowSeconds >= 0
				? fileObj.presenceWindowSeconds
				: defaults.presenceWindowSeconds,
		focusFallback: typeof fileObj.focusFallback === "boolean" ? fileObj.focusFallback : defaults.focusFallback,
		focusQueryTimeoutMs:
			typeof fileObj.focusQueryTimeoutMs === "number" && fileObj.focusQueryTimeoutMs > 0
				? fileObj.focusQueryTimeoutMs
				: defaults.focusQueryTimeoutMs,
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
	out.onQuestion = boolFromEnv(env.PI_NOTIFY_QUESTION, out.onQuestion);
	out.requireUI = boolFromEnv(env.PI_NOTIFY_REQUIRE_UI, out.requireUI);
	out.onlyWhenUnfocused = boolFromEnv(env.PI_NOTIFY_ONLY_WHEN_UNFOCUSED, out.onlyWhenUnfocused);
	out.focusFallback = boolFromEnv(env.PI_NOTIFY_FOCUS_FALLBACK, out.focusFallback);
	if (env.PI_NOTIFY_FOCUS_GRACE) {
		const n = Number(env.PI_NOTIFY_FOCUS_GRACE);
		if (Number.isFinite(n) && n >= 0) out.focusedGraceSeconds = n;
	}
	if (env.PI_NOTIFY_FOCUS_PRESENCE) {
		const n = Number(env.PI_NOTIFY_FOCUS_PRESENCE);
		if (Number.isFinite(n) && n >= 0) out.presenceWindowSeconds = n;
	}
	if (env.PI_NOTIFY_FOCUS_TIMEOUT) {
		const n = Number(env.PI_NOTIFY_FOCUS_TIMEOUT);
		if (Number.isFinite(n) && n > 0) out.focusQueryTimeoutMs = n;
	}
	if (env.PI_NOTIFY_QUESTION_TITLE && env.PI_NOTIFY_QUESTION_TITLE.length > 0) {
		out.questionTitle = env.PI_NOTIFY_QUESTION_TITLE;
	}
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
	// Переопределение команд текущей платформы: PI_NOTIFY_CMD_SOUND / PI_NOTIFY_CMD_PUSH / PI_NOTIFY_CMD_FOCUS.
	const plat = currentPlatform();
	if (env.PI_NOTIFY_CMD_SOUND) out.commands[plat] = { ...out.commands[plat], sound: env.PI_NOTIFY_CMD_SOUND };
	if (env.PI_NOTIFY_CMD_PUSH) out.commands[plat] = { ...out.commands[plat], push: env.PI_NOTIFY_CMD_PUSH };
	if (env.PI_NOTIFY_CMD_FOCUS) out.commands[plat] = { ...out.commands[plat], focus: env.PI_NOTIFY_CMD_FOCUS };
	return out;
}

/**
 * Признак WSL по окружению. WSL задаёт WSL_DISTRO_NAME и WSL_INTEROP в любом
 * дистрибутиве, но НЕ гарантирует, что они дойдут до процесса: tmux их не
 * передаёт в новые сессии, systemd и cron их не видят. Поэтому это только
 * первый источник, второй — wslFromProcVersion. Чистая функция от env.
 */
export function isWsl(env: Record<string, string | undefined> = process.env): boolean {
	return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

/**
 * Признак WSL по содержимому `/proc/version`: ядро WSL подписано
 * `-microsoft-standard-WSL1` / `-microsoft-standard-WSL2`. Чистая функция от
 * текста — тестируется офлайн, окружение процесса не нужно.
 */
export function wslFromProcVersion(procVersion: string): boolean {
	return /microsoft-standard-WSL/i.test(procVersion);
}

/** Кэш прочитанных системных файлов: /proc/version и /etc/os-release за процесс не меняются. */
const textCache = new Map<string, string>();

/** Прочитать текстовый файл; нет файла или нет прав — пустая строка. */
function readTextIfExists(path: string): string {
	const cached = textCache.get(path);
	if (cached !== undefined) return cached;
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch {
		text = "";
	}
	textCache.set(path, text);
	return text;
}

/**
 * Разрешить платформу по всем трём источникам. Чистая функция — аргументы
 * приходят извне, поэтому тестируется на любой ОС.
 */
export function platformFrom(
	nodePlatform: string,
	env: Record<string, string | undefined>,
	procVersion: string,
): Platform {
	if (nodePlatform === "darwin") return "darwin";
	if (nodePlatform === "win32") return "win32";
	if (isWsl(env) || wslFromProcVersion(procVersion)) return "wsl";
	return "linux";
}

/**
 * Платформа по умолчанию: process.platform + env + `/proc/version`.
 * Linux-ядро с признаком WSL → "wsl" (бить в Windows, не в нативный Linux).
 */
export function currentPlatform(
	env: Record<string, string | undefined> = process.env,
	procVersion = readTextIfExists("/proc/version"),
): Platform {
	return platformFrom(process.platform, env, procVersion);
}

/**
 * Имя дистрибутива для Windows-UNC `\\wsl.localhost\<distro>\...`.
 *
 * Порядок: `WSL_DISTRO_NAME`, затем `NAME`/`PRETTY_NAME` из `/etc/os-release`
 * (первое слово — «Ubuntu» для `Ubuntu 24.04.4 LTS`), затем «Ubuntu» как самое
 * частое зарегистрированное имя. Имя нужно только для пути звука: тост и
 * запрос фокуса путей не читают.
 */
export function wslDistroName(
	env: Record<string, string | undefined> = process.env,
	osRelease = readTextIfExists("/etc/os-release"),
): string {
	const fromEnv = env.WSL_DISTRO_NAME?.trim();
	if (fromEnv) return fromEnv;
	const name = /^NAME="([^"]+)"/m.exec(osRelease)?.[1]?.trim();
	if (name) return name.split(/\s+/)[0];
	const pretty = /^PRETTY_NAME="([^"]+)"/m.exec(osRelease)?.[1]?.trim();
	if (pretty) return pretty.split(/\s+/)[0];
	return "Ubuntu";
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
	if (platform === "wsl") return wslPathToWindows(raw, wslDistroName(env));
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
