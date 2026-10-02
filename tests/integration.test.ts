/**
 * Интеграционный smoke-тест: грузим реальную фабрику расширения с мок-pi,
 * проигрываем событийный цикл и проверяем, что env-нагрузка доходит до команды.
 *
 * Конфиг пишется в изолированный PI_CODING_AGENT_DIR (getAgentDir уважает эту
 * env-переменную), команды пуша/звука подменяются скриптом, который дампит
 * PI_NOTIFY_* в файл. Так проверяется вся связка: чтение конфига, порядок
 * событий, shouldNotify, buildEnv, runPlan/spawn — без реальной ОС-системы
 * нотификаций.
 *
 * Детач-процесс пишет асинхронно, поэтому содержимое ждём опросом (waitFor).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentPlatform } from "../config.ts";

// Платформа, которую реально резолвит расширение на этом хосте (linux/wsl/darwin).
// Тест пишет команды под неё, а не под хардкод, иначе на WSL промахнётся.
const plat = currentPlatform();

const base = mkdtempSync(join(tmpdir(), "pi-notify-it-"));
const agentDir = join(base, "agent");
mkdirSync(agentDir, { recursive: true });
const dumpScript = join(base, "dump.sh");
writeFileSync(
	dumpScript,
	`#!/bin/sh\necho "$1|$PI_NOTIFY_TITLE|$PI_NOTIFY_MESSAGE|$PI_NOTIFY_OUTCOME|$PI_NOTIFY_DURATION" >> "$DUMP_TO"\n`,
	{ mode: 0o755 },
);

/** Опрос: ждём, пока pred() не вернёт true, до дедлайна. */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return pred();
}

type Handler = (event: any, ctx: any) => any;
function makeMockPi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const pi = {
		on(event: string, handler: Handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
			return () => {};
		},
		registerCommand(name: string, opts: any) {
			commands.set(name, opts);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands };
}

const ctx = { hasUI: false, mode: "print", ui: { notify: () => {} } } as any;

async function fire(handlers: Map<string, Handler[]>, event: any) {
	for (const h of handlers.get(event.type) ?? []) await h(event, ctx);
}

/** Чистим PI_NOTIFY_* и ставим изолированный agent-dir + дамп-файл. */
function setupEnv(outFile: string) {
	for (const k of Object.keys(process.env)) {
		if (k.startsWith("PI_NOTIFY")) delete process.env[k];
	}
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.DUMP_TO = outFile;
}

function writeConfig(obj: unknown) {
	writeFileSync(join(agentDir, "notify.json"), JSON.stringify(obj), "utf8");
}

const dump = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");

test("end-to-end: completed run fires sound + push with env payload", async () => {
	const out = join(base, "out1.txt");
	setupEnv(out);
	writeConfig({
		enabled: true,
		sound: true,
		push: true,
		minDurationSeconds: 0,
		commands: { [plat]: { sound: `${dumpScript} sound`, push: `${dumpScript} push` } },
	});

	const { default: factory } = await import("../index.ts");
	const { pi, handlers } = makeMockPi();
	factory(pi);

	await fire(handlers, { type: "agent_start" });
	await fire(handlers, {
		type: "agent_end",
		messages: [{ role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: "Задача сделана" }] }],
	});
	await fire(handlers, { type: "agent_before_settle", outcome: "completed" });
	await fire(handlers, { type: "agent_settled" });

	const ok = await waitFor(() => /push\|/.test(dump(out)) && /sound\|/.test(dump(out)));
	assert.ok(ok, `expected both channels, got: ${dump(out)}`);
	assert.match(dump(out), /push\|Pi\|Задача сделана\|completed\|\d+/);
	assert.match(dump(out), /sound\|Pi\|Задача сделана\|completed\|\d+/);
});

test("end-to-end: aborted fires push only when sound channel disabled", async () => {
	const out = join(base, "out2.txt");
	setupEnv(out);
	writeConfig({
		enabled: true,
		sound: false,
		push: true,
		commands: { [plat]: { push: `${dumpScript} push` } },
	});

	const { default: factory } = await import("../index.ts");
	const { pi, handlers } = makeMockPi();
	factory(pi);

	await fire(handlers, { type: "agent_start" });
	await fire(handlers, { type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] });
	await fire(handlers, { type: "agent_before_settle", outcome: "aborted" });
	await fire(handlers, { type: "agent_settled" });

	const ok = await waitFor(() => /push\|/.test(dump(out)));
	assert.ok(ok, `expected push channel, got: ${dump(out)}`);
	assert.match(dump(out), /push\|Pi\|Прервано пользователем\|aborted\|\d+/);
	assert.doesNotMatch(dump(out), /sound\|/);
});

test("end-to-end: disabled master fires nothing", async () => {
	const out = join(base, "out3.txt");
	setupEnv(out);
	writeConfig({ enabled: false, commands: { [plat]: { push: `${dumpScript} push` } } });

	const { default: factory } = await import("../index.ts");
	const { pi, handlers } = makeMockPi();
	factory(pi);

	await fire(handlers, { type: "agent_start" });
	await fire(handlers, { type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn", content: "x" }] });
	await fire(handlers, { type: "agent_before_settle", outcome: "completed" });
	await fire(handlers, { type: "agent_settled" });

	// Дедлайн короткий: если бы канал стрелял, файл бы появился.
	const appeared = await waitFor(() => existsSync(out), 300);
	assert.equal(appeared, false, "nothing must fire when disabled");
});

test("end-to-end: below min duration suppresses notification", async () => {
	const out = join(base, "out4.txt");
	setupEnv(out);
	writeConfig({
		enabled: true,
		minDurationSeconds: 9999,
		commands: { [plat]: { push: `${dumpScript} push` } },
	});

	const { default: factory } = await import("../index.ts");
	const { pi, handlers } = makeMockPi();
	factory(pi);

	await fire(handlers, { type: "agent_start" });
	await fire(handlers, { type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn", content: "x" }] });
	await fire(handlers, { type: "agent_before_settle", outcome: "completed" });
	await fire(handlers, { type: "agent_settled" });

	const appeared = await waitFor(() => existsSync(out), 300);
	assert.equal(appeared, false, "short run must be suppressed by minDurationSeconds");
});

test("registers /notify-test and /notify-status commands", async () => {
	setupEnv(join(base, "unused.txt"));
	writeConfig({ enabled: true });
	const { default: factory } = await import("../index.ts");
	const { pi, commands } = makeMockPi();
	factory(pi);
	assert.ok(commands.has("notify-test"));
	assert.ok(commands.has("notify-status"));
});
