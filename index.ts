import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	consumeRateLimitResetCredit,
	getWeeklyWindow,
	readAccountRateLimits,
	type AccountRateLimits,
	type ConsumeResetResponse,
	type ResetOutcome,
} from "./codex-app-server.ts";

const COMMAND = "reset-codex";
const STATUS_KEY = "pi-codex-reset";

export type ResetCodexDependencies = {
	readRateLimits: () => Promise<AccountRateLimits>;
	consumeReset: (idempotencyKey: string) => Promise<ConsumeResetResponse>;
	createIdempotencyKey: () => string;
};

const defaultDependencies: ResetCodexDependencies = {
	readRateLimits: readAccountRateLimits,
	consumeReset: consumeRateLimitResetCredit,
	createIdempotencyKey: randomUUID,
};

function availableCount(rateLimits: AccountRateLimits): number | undefined {
	const count = rateLimits.rateLimitResetCredits?.availableCount;
	return typeof count === "number" ? count : undefined;
}

function formatUsage(rateLimits: AccountRateLimits): string {
	const weekly = getWeeklyWindow(rateLimits);
	return weekly ? `${weekly.usedPercent}%` : "不明";
}

function formatCount(count: number | undefined): string {
	return count === undefined ? "不明" : `${count}回`;
}

function notify(
	ctx: ExtensionCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.mode === "print") {
		console.log(message);
		return;
	}
	if (ctx.mode === "json") return;
	ctx.ui.notify(message, type);
}

function outcomeMessage(outcome: Exclude<ResetOutcome, "reset" | "alreadyRedeemed">): string {
	if (outcome === "nothingToReset") return "現在リセットできるCodex利用枠はありません。";
	return "利用可能なCodexリセット権がありません。";
}

async function showSuccess(
	ctx: ExtensionCommandContext,
	before: AccountRateLimits,
	dependencies: ResetCodexDependencies,
): Promise<void> {
	ctx.ui.setStatus(STATUS_KEY, "Codex limitを再確認中…");
	try {
		const after = await dependencies.readRateLimits();
		notify(
			ctx,
			`Codex weekly limitをリセットしました（${formatUsage(before)} → ${formatUsage(after)}、残り${formatCount(availableCount(after))}）。`,
			"info",
		);
	} catch {
		notify(ctx, "Codex weekly limitをリセットしました。最新状態の再取得には失敗しました。", "warning");
	}
}

export function createResetCodexHandler(dependencies: ResetCodexDependencies = defaultDependencies) {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (args.trim() !== "") {
			notify(ctx, "/reset-codex に引数はありません。", "warning");
			return;
		}
		if (!ctx.hasUI) {
			notify(ctx, "/reset-codex はPiの対話モードで実行してください。", "warning");
			return;
		}

		ctx.ui.setStatus(STATUS_KEY, "Codex limitを確認中…");
		try {
			const before = await dependencies.readRateLimits();
			const count = availableCount(before);
			if (count !== undefined && count <= 0) {
				notify(ctx, "利用可能なCodexリセット権がありません。", "warning");
				return;
			}

			ctx.ui.setStatus(STATUS_KEY, undefined);
			const confirmed = await ctx.ui.confirm(
				"Codex weekly limitをリセット？",
				`獲得済みリセット権を1回使用します。\n現在のweekly使用率: ${formatUsage(before)}\n利用可能: ${formatCount(count)}`,
			);
			if (!confirmed) {
				notify(ctx, "Codex limitのリセットをキャンセルしました。", "info");
				return;
			}

			ctx.ui.setStatus(STATUS_KEY, "Codex weekly limitをリセット中…");
			const result = await dependencies.consumeReset(dependencies.createIdempotencyKey());
			if (result.outcome === "reset" || result.outcome === "alreadyRedeemed") {
				await showSuccess(ctx, before, dependencies);
				return;
			}
			notify(ctx, outcomeMessage(result.outcome), "warning");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Codex weekly limitのリセットに失敗しました: ${message}`, "error");
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	};
}

export default function piCodexResetExtension(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND, {
		description: "獲得済みのリセット権でCodex weekly limitをリセットする",
		handler: createResetCodexHandler(),
	});
}
