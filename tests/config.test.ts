/**
 * Офлайн-тесты слияния конфигурации и env-переопределений (config.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyEnvOverrides,
	bundledSoundPath,
	clampVolume,
	DEFAULT_CONFIG,
	DEFAULT_COMMANDS,
	isWsl,
	mergeCommands,
	mergeConfig,
	normalizeNotifyOn,
	psEncode,
	resolveSoundFile,
	wslPathToWindows,
} from "../config.ts";

test("clampVolume: режет в [0,1], невалидное → fallback", () => {
	assert.equal(clampVolume(0.5, 0.4), 0.5);
	assert.equal(clampVolume(1.5, 0.4), 1);
	assert.equal(clampVolume(-2, 0.4), 0);
	assert.equal(clampVolume("x", 0.4), 0.4);
	assert.equal(clampVolume(undefined, 0.4), 0.4);
});

test("mergeConfig: volume из файла, с клампом", () => {
	assert.equal(mergeConfig({ volume: 0.25 }, DEFAULT_CONFIG).volume, 0.25);
	assert.equal(mergeConfig({ volume: 3 }, DEFAULT_CONFIG).volume, 1);
	assert.equal(mergeConfig({ volume: "loud" }, DEFAULT_CONFIG).volume, DEFAULT_CONFIG.volume);
});

test("applyEnvOverrides: PI_NOTIFY_VOLUME", () => {
	assert.equal(applyEnvOverrides(DEFAULT_CONFIG, { PI_NOTIFY_VOLUME: "0.15" }).volume, 0.15);
	assert.equal(applyEnvOverrides(DEFAULT_CONFIG, { PI_NOTIFY_VOLUME: "9" }).volume, 1);
	assert.equal(applyEnvOverrides(DEFAULT_CONFIG, { PI_NOTIFY_VOLUME: "abc" }).volume, DEFAULT_CONFIG.volume);
});

test("wslPathToWindows: WSL-путь → UNC, windows-путь как есть", () => {
	assert.equal(
		wslPathToWindows("/home/u/proj/a.mp3", "Ubuntu"),
		"\\\\wsl.localhost\\Ubuntu\\home\\u\\proj\\a.mp3",
	);
	// уже диск Windows — не трогаем
	assert.equal(wslPathToWindows("C:\\Sounds\\x.mp3", "Ubuntu"), "C:\\Sounds\\x.mp3");
	// уже UNC — не трогаем
	assert.equal(wslPathToWindows("\\\\server\\share\\x.mp3", "Ubuntu"), "\\\\server\\share\\x.mp3");
	// лишние ведущие слеши схлопываются
	assert.equal(wslPathToWindows("//home/u/x", "Deb"), "\\\\wsl.localhost\\Deb\\home\\u\\x");
});

test("resolveSoundFile: null → встроенный asset; в WSL → UNC", () => {
	const bundled = bundledSoundPath();
	assert.match(bundled, /assets[\\/]notify\.mp3$/);
	// linux — как есть (bundled)
	assert.equal(resolveSoundFile({ soundFile: null }, "linux"), bundled);
	// wsl — сконвертированный bundled
	assert.equal(
		resolveSoundFile({ soundFile: null }, "wsl", { WSL_DISTRO_NAME: "Ubuntu" }),
		wslPathToWindows(bundled, "Ubuntu"),
	);
	// override respected
	assert.equal(resolveSoundFile({ soundFile: "/custom/s.mp3" }, "linux"), "/custom/s.mp3");
	assert.equal(
		resolveSoundFile({ soundFile: "/custom/s.mp3" }, "wsl", { WSL_DISTRO_NAME: "Ubuntu" }),
		"\\\\wsl.localhost\\Ubuntu\\custom\\s.mp3",
	);
	// windows-override в WSL не конвертируется
	assert.equal(
		resolveSoundFile({ soundFile: "D:\\s.mp3" }, "wsl", { WSL_DISTRO_NAME: "Ubuntu" }),
		"D:\\s.mp3",
	);
});

test("mergeConfig: soundFile и soundDurationMs из файла", () => {
	const cfg = mergeConfig({ soundFile: "/x/y.mp3", soundDurationMs: 3000 }, DEFAULT_CONFIG);
	assert.equal(cfg.soundFile, "/x/y.mp3");
	assert.equal(cfg.soundDurationMs, 3000);
	// пустая строка → дефолт (null)
	assert.equal(mergeConfig({ soundFile: "" }, DEFAULT_CONFIG).soundFile, DEFAULT_CONFIG.soundFile);
	// невалидное число → дефолт
	assert.equal(mergeConfig({ soundDurationMs: -1 }, DEFAULT_CONFIG).soundDurationMs, DEFAULT_CONFIG.soundDurationMs);
});

test("applyEnvOverrides: PI_NOTIFY_SOUND_FILE / PI_NOTIFY_SOUND_DURATION", () => {
	const cfg = applyEnvOverrides(DEFAULT_CONFIG, {
		PI_NOTIFY_SOUND_FILE: "/env/s.mp3",
		PI_NOTIFY_SOUND_DURATION: "2500",
	});
	assert.equal(cfg.soundFile, "/env/s.mp3");
	assert.equal(cfg.soundDurationMs, 2500);
});

test("isWsl: true по WSL_DISTRO_NAME или WSL_INTEROP", () => {
	assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }), true);
	assert.equal(isWsl({ WSL_INTEROP: "/run/WSL/1706_interop" }), true);
	assert.equal(isWsl({}), false);
	assert.equal(isWsl({ WSL_DISTRO_NAME: "" }), false);
});

test("DEFAULT_COMMANDS.wsl использует powershell.exe (interop-имя)", () => {
	assert.match(DEFAULT_COMMANDS.wsl.sound!, /^powershell\.exe /);
	assert.match(DEFAULT_COMMANDS.wsl.push!, /^powershell\.exe /);
	// нативный win32 — без .exe
	assert.match(DEFAULT_COMMANDS.win32.push!, /^powershell /);
});

test("normalizeNotifyOn: filters valid, dedups, keeps fallback on empty", () => {
	assert.deepEqual(normalizeNotifyOn(["completed", "error", "bogus", "completed"], ["completed"]), ["completed", "error"]);
	assert.deepEqual(normalizeNotifyOn(["nope"], ["aborted"]), ["aborted"]);
	assert.deepEqual(normalizeNotifyOn(undefined, ["completed", "aborted"]), ["completed", "aborted"]);
});

test("mergeConfig: file fields override defaults", () => {
	const cfg = mergeConfig(
		{ enabled: false, sound: false, title: "Мой агент", minDurationSeconds: 15, notifyOn: ["error"] },
		DEFAULT_CONFIG,
	);
	assert.equal(cfg.enabled, false);
	assert.equal(cfg.sound, false);
	assert.equal(cfg.title, "Мой агент");
	assert.equal(cfg.minDurationSeconds, 15);
	assert.deepEqual(cfg.notifyOn, ["error"]);
	// Не указанные команды остаются дефолтными.
	assert.equal(cfg.commands.darwin.push, DEFAULT_CONFIG.commands.darwin.push);
});

test("mergeConfig: invalid types fall back to defaults", () => {
	const cfg = mergeConfig({ enabled: "yes", minDurationSeconds: -3, title: "" }, DEFAULT_CONFIG);
	assert.equal(cfg.enabled, DEFAULT_CONFIG.enabled);
	assert.equal(cfg.minDurationSeconds, DEFAULT_CONFIG.minDurationSeconds);
	assert.equal(cfg.title, DEFAULT_CONFIG.title);
});

test("mergeConfig: non-object throws", () => {
	assert.throws(() => mergeConfig("nope", DEFAULT_CONFIG), /JSON object/);
	assert.throws(() => mergeConfig(null, DEFAULT_CONFIG), /JSON object/);
});

test("mergeCommands: per-platform override, unknown platform ignored", () => {
	const merged = mergeCommands(
		{
			linux: { push: "my-notify.sh" },
			solaris: { push: "nope" },
			darwin: { sound: 123 },
		},
		DEFAULT_CONFIG.commands,
	);
	assert.equal(merged.linux.push, "my-notify.sh");
	// sound не указан для linux — дефолт сохранён.
	assert.equal(merged.linux.sound, DEFAULT_CONFIG.commands.linux.sound);
	// darwin.sound невалидный (число) — дефолт.
	assert.equal(merged.darwin.sound, DEFAULT_CONFIG.commands.darwin.sound);
	// неизвестная платформа не добавлена.
	assert.equal((merged as Record<string, unknown>).solaris, undefined);
});

test("mergeCommands: undefined leaves defaults intact", () => {
	const merged = mergeCommands(undefined, DEFAULT_CONFIG.commands);
	assert.deepEqual(merged, DEFAULT_CONFIG.commands);
});

test("applyEnvOverrides: master + channel toggles", () => {
	const cfg = applyEnvOverrides(DEFAULT_CONFIG, { PI_NOTIFY: "0" });
	assert.equal(cfg.enabled, false);
	const cfg2 = applyEnvOverrides(DEFAULT_CONFIG, { PI_NOTIFY_SOUND: "false", PI_NOTIFY_PUSH: "0" });
	assert.equal(cfg2.sound, false);
	assert.equal(cfg2.push, false);
});

test("applyEnvOverrides: title, min duration", () => {
	const cfg = applyEnvOverrides(DEFAULT_CONFIG, { PI_NOTIFY_TITLE: "Бот", PI_NOTIFY_MIN_DURATION: "30" });
	assert.equal(cfg.title, "Бот");
	assert.equal(cfg.minDurationSeconds, 30);
	// Невалидное число игнорируется.
	const cfg2 = applyEnvOverrides(DEFAULT_CONFIG, { PI_NOTIFY_MIN_DURATION: "abc" });
	assert.equal(cfg2.minDurationSeconds, DEFAULT_CONFIG.minDurationSeconds);
});

test("applyEnvOverrides: empty title ignored", () => {
	const cfg = applyEnvOverrides(DEFAULT_CONFIG, { PI_NOTIFY_TITLE: "" });
	assert.equal(cfg.title, DEFAULT_CONFIG.title);
});

test("applyEnvOverrides: does not mutate the input config", () => {
	const before = structuredClone(DEFAULT_CONFIG);
	applyEnvOverrides(DEFAULT_CONFIG, { PI_NOTIFY_TITLE: "X", PI_NOTIFY_CMD_PUSH: "y.sh" });
	assert.deepEqual(DEFAULT_CONFIG, before, "DEFAULT_CONFIG must stay pristine");
});

test("psEncode: produces valid UTF-16LE base64 roundtrip", () => {
	const script = "Write-Host 'привет'";
	const enc = psEncode(script);
	const decoded = Buffer.from(enc, "base64").toString("utf16le");
	assert.equal(decoded, script);
});
