/**
 * pi-notify — точка входа.
 *
 * Уведомляет о завершении работы агента: играет звук и шлёт пуш (Windows toast,
 * macOS notification, Linux notify-send или произвольный скрипт из конфига).
 *
 * Событийная модель:
 *   agent_start        → запоминаем время начала (первый в цикле settle)
 *   agent_end          → извлекаем итог и текст из сообщений (перезаписываем
 *                        при каждой retry-итерации — нужен последний)
 *   agent_before_settle→ авторитетный итог (completed/aborted/error)
 *   agent_settled      → финальный триггер: Pi больше не продолжит сам, шлём
 *   rpiv:ask-user:prompt (pi.events) → агент задал вопрос и ждёт ответа;
 *                        отдельный триггер, вне notifyOn и minDurationSeconds
 *
 * Оба триггера пропускаются, если `requireUI` включён и у сессии нет UI
 * (`ctx.hasUI === false`). Так молчат headless-рантаймы фоновых сабагентов:
 * каждый из них поднимает свой экземпляр расширения и иначе слал бы свой пуш.
 *
 * agent_settled выбран точкой выстрела, потому что это единственная граница,
 * после которой гарантированно нет авто-retry/compaction/queued-continuation.
 * agent_end стреляет и перед retry — уведомлять на нём значило бы дублировать.
 *
 * Вопрос — не итог прогона, а отдельная блокировка: пока человек не ответил,
 * settle не наступит, и без отдельного хука уведомление по фоновому агенту
 * не приходило бы вовсе.
 *
 * Конфиг: ~/.pi/agent/notify.json (пер-машинный), поверх — env PI_NOTIFY_*.
 * Текст уведомления передаётся дочерним процессам только через env, не через
 * интерполяцию в команду. См. config.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentPlatform, loadConfig, resolveSoundFile, type NotifyConfig, type Outcome } from "./config.ts";
import { buildEnv, buildPlan, shouldNotify, summarize, questionMessage, ASK_USER_PROMPT_CHANNEL, type NotifyKind } from "./notify.ts";
import { runPlan } from "./exec.ts";

export default function (pi: ExtensionAPI): void {
	const cfg: NotifyConfig = loadConfig();
	const platform = currentPlatform();

	// Состояние текущего цикла прогона (переживает retry-итерации до settle).
	let runStartMs: number | undefined;
	let lastOutcome: Outcome = "completed";
	let lastMessage = "";

	function fire(
		title: string,
		message: string,
		outcome: Outcome,
		durationSeconds: number,
		kind: NotifyKind = "run",
	): void {
		const plan = buildPlan(cfg, platform);
		if (!plan.sound && !plan.push) return;
		const env = buildEnv({
			title,
			message,
			outcome,
			durationSeconds,
			kind,
			soundFile: plan.sound ? resolveSoundFile(cfg, platform) : undefined,
			soundDurationMs: cfg.soundDurationMs,
			volume: cfg.volume,
			wsl: platform === "wsl",
			existingWslenv: process.env.WSLENV,
		});
		runPlan(plan, {
			env,
			onLog: (channel, _cmd, error) => {
				if (error) {
					// Диагностика наружу, но не как ошибка сессии.
					ctx_notify(`pi-notify: канал ${channel} не запустился: ${error}`, "warning");
				}
			},
		});
	}

	// ctx для диагностики вне контекста события недоступен; кэшируем последний ctx.
	let lastCtx: ExtensionContext | undefined;
	function ctx_notify(msg: string, level: "info" | "warning" | "error"): void {
		if (lastCtx?.hasUI) lastCtx.ui.notify(msg, level);
	}

	/**
	 * Пускать ли сигнал из этой сессии. При `requireUI` молчим там, где UI нет:
	 * это headless-рантаймы фоновых сабагентов и печатный режим. Отсутствие ctx
	 * трактуем как «UI нет» — сигнал из ниоткуда хуже, чем тишина.
	 */
	function uiAllowed(ctx?: ExtensionContext): boolean {
		return !cfg.requireUI || ctx?.hasUI === true;
	}

	pi.on("session_start", (_event, ctx) => {
		// Самый ранний момент, где ctx уже есть: нужен, чтобы вопрос до первого
		// agent_start тоже решался по requireUI, а не молчал из-за пустого ctx.
		lastCtx = ctx;
	});

	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx;
		// Ставим старт только если его ещё нет в этом settle-цикле: retries не
		// должны обнулять отсчёт — метрика «от запроса до финала».
		if (runStartMs === undefined) runStartMs = Date.now();
	});

	pi.on("agent_end", (event) => {
		const summary = summarize(event.messages);
		lastOutcome = summary.outcome;
		lastMessage = summary.message;
	});

	pi.on("agent_before_settle", (event) => {
		// Авторитетный итог от Pi перекрывает нашу эвристику по stopReason.
		lastOutcome = event.outcome;
	});

	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		const start = runStartMs;
		const durationSeconds = start === undefined ? 0 : (Date.now() - start) / 1000;

		// Сброс состояния ДО решения о пуше: settle завершает цикл.
		runStartMs = undefined;
		const outcome = lastOutcome;
		const message = lastMessage || defaultText(outcome);
		lastOutcome = "completed";
		lastMessage = "";

		if (!uiAllowed(ctx)) return;
		if (!shouldNotify(cfg, outcome, durationSeconds)) return;
		fire(cfg.title, message, outcome, durationSeconds);
	});

	// Вопрос от инструмента ask_user_question. Канал публикует
	// @juicesharp/rpiv-ask-user-question в момент, когда вопрос показан
	// пользователю и ждёт ответа. Порог длительности и notifyOn здесь не
	// применяются: агент заблокирован, ждать более позднего момента
	// бессмысленно. `enabled` и `onQuestion` по-прежнему глушат сигнал.
	// Подписка живёт на event-шине того рантайма расширений, где загружено
	// расширение, — фоновый сабагент со своим рантаймом уведомляет сам себя.
	const unsubscribeAsk = pi.events.on(ASK_USER_PROMPT_CHANNEL, (payload: unknown) => {
		if (!cfg.enabled || !cfg.onQuestion || !uiAllowed(lastCtx)) return;
		const start = runStartMs;
		const durationSeconds = start === undefined ? 0 : (Date.now() - start) / 1000;
		fire(cfg.questionTitle, questionMessage(payload), "completed", durationSeconds, "question");
	});
	pi.on("session_shutdown", () => {
		unsubscribeAsk();
	});

	// /notify-test — мгновенно слать тестовое уведомление текущему платформенному
	// плану, в обход порога длительности. Для проверки звука и пуша на машине.
	pi.registerCommand("notify-test", {
		description: "pi-notify: тестовое уведомление (звук + пуш) текущей платформы",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			const plan = buildPlan(cfg, platform);
			if (!plan.sound && !plan.push) {
				ctx.ui.notify(`pi-notify: для платформы ${platform} нет команд (звук/пуш выключены или пусты)`, "warning");
				return;
			}
			const env = buildEnv({
				title: cfg.title,
				message: "Тестовое уведомление pi-notify",
				outcome: "completed",
				durationSeconds: 0,
				soundFile: plan.sound ? resolveSoundFile(cfg, platform) : undefined,
				soundDurationMs: cfg.soundDurationMs,
				volume: cfg.volume,
				wsl: platform === "wsl",
				existingWslenv: process.env.WSLENV,
			});
			const started = runPlan(plan, {
				env,
				onLog: (channel, _cmd, error) => {
					if (error) ctx.ui.notify(`pi-notify: канал ${channel}: ${error}`, "warning");
				},
			});
			ctx.ui.notify(
				`pi-notify: тест запущен на ${platform} — каналы: ${started.join(", ") || "нет"}`,
				"info",
			);
		},
	});

	// /notify-status — показать разрешённый конфиг (без секретов).
	pi.registerCommand("notify-status", {
		description: "pi-notify: показать активные настройки и команды платформы",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			const plan = buildPlan(cfg, platform);
			const lines = [
				`enabled=${cfg.enabled} sound=${cfg.sound} push=${cfg.push}`,
				`minDuration=${cfg.minDurationSeconds}s notifyOn=${cfg.notifyOn.join(",")}`,
				`onQuestion=${cfg.onQuestion} questionTitle="${cfg.questionTitle}"`,
				`requireUI=${cfg.requireUI} (hasUI=${ctx.hasUI})`,
				`title="${cfg.title}" platform=${platform}`,
				`sound cmd: ${plan.sound ?? "(нет)"}`,
				`push  cmd: ${plan.push ?? "(нет)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

function defaultText(outcome: Outcome): string {
	if (outcome === "aborted") return "Прервано пользователем";
	if (outcome === "error") return "Ошибка при выполнении";
	return "Готово";
}
