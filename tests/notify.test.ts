/**
 * Офлайн-тесты чистой логики notify.ts: извлечение итога, текст, порог, план.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { WSL_PASSTHROUGH_VARS } from "../config.ts";
import {
	buildEnv,
	buildPlan,
	buildWslPassthrough,
	commandFor,
	lastAssistantText,
	outcomeFromMessages,
	shouldNotify,
	summarize,
	truncate,
} from "../notify.ts";
import { DEFAULT_CONFIG } from "../config.ts";

type Msg = { role: string; stopReason?: string; content?: unknown };

test("outcomeFromMessages: last assistant stopReason decides", () => {
	assert.equal(outcomeFromMessages([{ role: "user" }, { role: "assistant", stopReason: "end_turn" }]), "completed");
	assert.equal(outcomeFromMessages([{ role: "assistant", stopReason: "toolUse" }, { role: "assistant", stopReason: "aborted" }]), "aborted");
	assert.equal(outcomeFromMessages([{ role: "assistant", stopReason: "aborted" }, { role: "assistant", stopReason: "error" }]), "error");
});

test("outcomeFromMessages: empty / no-assistant → completed", () => {
	assert.equal(outcomeFromMessages([]), "completed");
	assert.equal(outcomeFromMessages([{ role: "user" }, { role: "toolResult" }]), "completed");
});

test("lastAssistantText: joins text blocks of last assistant msg", () => {
	const msgs: Msg[] = [
		{ role: "assistant", content: [{ type: "text", text: "старо " }] },
		{ role: "user", content: "вопрос" },
		{ role: "assistant", content: [{ type: "text", text: "привет" }, { type: "toolCall", id: "1" }, { type: "text", text: " мир" }] },
	];
	assert.equal(lastAssistantText(msgs), "привет мир");
});

test("lastAssistantText: string content trimmed", () => {
	assert.equal(lastAssistantText([{ role: "assistant", content: "  done  " }]), "done");
});

test("lastAssistantText: skips assistant with only toolCalls, finds earlier text", () => {
	const msgs: Msg[] = [
		{ role: "assistant", content: [{ type: "text", text: "ответ" }] },
		{ role: "toolResult" },
		{ role: "assistant", content: [{ type: "toolCall", id: "x" }] },
	];
	assert.equal(lastAssistantText(msgs), "ответ");
});

test("lastAssistantText: nothing → empty string", () => {
	assert.equal(lastAssistantText([{ role: "user", content: "hi" }]), "");
});

test("summarize: completed with text", () => {
	const s = summarize([{ role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: "Готово, 5 файлов" }] }]);
	assert.equal(s.outcome, "completed");
	assert.equal(s.message, "Готово, 5 файлов");
});

test("summarize: aborted without text → fallback message", () => {
	const s = summarize([{ role: "assistant", stopReason: "aborted", content: [{ type: "toolCall", id: "1" }] }]);
	assert.equal(s.outcome, "aborted");
	assert.equal(s.message, "Прервано пользователем");
});

test("summarize: error without text → fallback message", () => {
	const s = summarize([{ role: "assistant", stopReason: "error" }]);
	assert.equal(s.outcome, "error");
	assert.equal(s.message, "Ошибка при выполнении");
});

test("truncate: leaves short text, clips long with ellipsis", () => {
	assert.equal(truncate("abc", 10), "abc");
	assert.equal(truncate("abcdefghij", 5), "abcd…");
	assert.equal(truncate("a b c d e f", 7), "a b c…");
});

test("shouldNotify: disabled master → false", () => {
	assert.equal(shouldNotify({ enabled: false, notifyOn: ["completed"], minDurationSeconds: 0 }, "completed", 99), false);
});

test("shouldNotify: outcome not in list → false", () => {
	assert.equal(shouldNotify({ enabled: true, notifyOn: ["error"], minDurationSeconds: 0 }, "completed", 99), false);
});

test("shouldNotify: below min duration → false", () => {
	assert.equal(shouldNotify({ enabled: true, notifyOn: ["completed"], minDurationSeconds: 10 }, "completed", 5), false);
});

test("shouldNotify: all gates pass → true", () => {
	assert.equal(shouldNotify({ enabled: true, notifyOn: ["completed", "aborted"], minDurationSeconds: 3 }, "aborted", 4), true);
});

test("buildEnv: carries all four fields, duration rounded", () => {
	const env = buildEnv({ title: "Заголовок", message: "Тело", outcome: "error", durationSeconds: 12.6 });
	assert.deepEqual(env, {
		PI_NOTIFY_TITLE: "Заголовок",
		PI_NOTIFY_MESSAGE: "Тело",
		PI_NOTIFY_OUTCOME: "error",
		PI_NOTIFY_DURATION: "13",
	});
});

test("buildEnv: soundFile/soundDurationMs попадают в env, если заданы", () => {
	const env = buildEnv({
		title: "T",
		message: "M",
		outcome: "completed",
		durationSeconds: 1,
		soundFile: "C:\\x.mp3",
		soundDurationMs: 4200,
		volume: 0.3,
	});
	assert.equal(env.PI_NOTIFY_SOUND_FILE, "C:\\x.mp3");
	assert.equal(env.PI_NOTIFY_SOUND_DURATION, "4200");
	assert.equal(env.PI_NOTIFY_SOUND_VOLUME, "0.3");
	// без звука — ключей нет
	const noSound = buildEnv({ title: "T", message: "M", outcome: "completed", durationSeconds: 1 });
	assert.equal(noSound.PI_NOTIFY_SOUND_FILE, undefined);
	assert.equal(noSound.PI_NOTIFY_SOUND_DURATION, undefined);
});

test("buildEnv: wsl=true добавляет WSLENV, wsl=false — нет", () => {
	const noWsl = buildEnv({ title: "T", message: "M", outcome: "completed", durationSeconds: 1, wsl: false });
	assert.equal(noWsl.WSLENV, undefined);
	const wsl = buildEnv({ title: "T", message: "M", outcome: "completed", durationSeconds: 1, wsl: true });
	assert.ok(wsl.WSLENV);
	assert.match(wsl.WSLENV!, /PI_NOTIFY_TITLE/);
	assert.match(wsl.WSLENV!, /PI_NOTIFY_SOUND_FILE/);
});

test("buildWslPassthrough: включает все имена из WSL_PASSTHROUGH_VARS", () => {
	const v = buildWslPassthrough();
	for (const name of WSL_PASSTHROUGH_VARS) {
		assert.ok(v.split(":").includes(name), `missing ${name} in ${v}`);
	}
});

test("buildWslPassthrough: сохраняет чужие записи и не дублирует свои", () => {
	const v = buildWslPassthrough("MYVAR/p:PI_NOTIFY_TITLE");
	assert.ok(v.split(":").includes("MYVAR/p"), "чужая запись сохранена");
	// PI_NOTIFY_TITLE уже есть — не должно стать дважды
	const count = v.split(":").filter((p) => p.split("/")[0] === "PI_NOTIFY_TITLE").length;
	assert.equal(count, 1);
});

test("commandFor: returns trimmed command or null", () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	assert.equal(commandFor(cfg, "linux", "push"), 'notify-send "$PI_NOTIFY_TITLE" "$PI_NOTIFY_MESSAGE"');
	cfg.commands.linux.push = "   ";
	assert.equal(commandFor(cfg, "linux", "push"), null);
	cfg.commands.linux.push = undefined;
	assert.equal(commandFor(cfg, "linux", "push"), null);
});

test("buildPlan: respects sound/push flags", () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	let plan = buildPlan(cfg, "darwin");
	assert.ok(plan.sound && plan.push);

	cfg.sound = false;
	plan = buildPlan(cfg, "darwin");
	assert.equal(plan.sound, null);
	assert.ok(plan.push);

	cfg.push = false;
	plan = buildPlan(cfg, "darwin");
	assert.equal(plan.sound, null);
	assert.equal(plan.push, null);
});

test("buildPlan: unknown/empty platform command → null channel", () => {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.commands.linux.sound = "";
	const plan = buildPlan(cfg, "linux");
	assert.equal(plan.sound, null);
	assert.ok(plan.push);
});
