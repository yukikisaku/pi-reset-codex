import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	consumeRateLimitResetCredit,
	getWeeklyWindow,
	readAccountRateLimits,
	type AccountRateLimits,
} from "../codex-app-server.ts";
import { createResetCodexHandler } from "../index.ts";

const tmp = mkdtempSync(join(tmpdir(), "pi-codex-reset-"));
const fakeCodexScript = join(tmp, "fake-codex.mjs");
const capturePath = join(tmp, "consume.json");

const fakeServer = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let buffer = "";
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
const snapshot = {
  limitId: "codex",
  primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1800000000 },
  secondary: { usedPercent: 76, windowDurationMins: 10080, resetsAt: 1800500000 }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "fake-codex" } });
    } else if (message.method === "account/rateLimits/read") {
      send({
        id: message.id,
        result: {
          rateLimits: snapshot,
          rateLimitsByLimitId: { codex: snapshot },
          rateLimitResetCredits: { availableCount: 2 }
        }
      });
    } else if (message.method === "account/rateLimitResetCredit/consume") {
      writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify(message.params));
      send({ id: message.id, result: { outcome: "reset" } });
    }
  }
});
`;

function createContext(confirmed: boolean) {
	const notifications: Array<{ message: string; type: string }> = [];
	let confirms = 0;
	return {
		ctx: {
			mode: "tui",
			hasUI: true,
			ui: {
				confirm: async () => {
					confirms++;
					return confirmed;
				},
				notify: (message: string, type: string) => notifications.push({ message, type }),
				setStatus: () => {},
			},
		} as any,
		notifications,
		get confirms() {
			return confirms;
		},
	};
}

writeFileSync(fakeCodexScript, fakeServer, "utf8");

try {
	const options = {
		command: process.execPath,
		args: [fakeCodexScript],
		timeoutMs: 2_000,
		env: { ...process.env, FAKE_CAPTURE: capturePath },
	};
	const limits = await readAccountRateLimits(options);
	assert.equal(limits.rateLimitResetCredits?.availableCount, 2);
	assert.equal(getWeeklyWindow(limits)?.usedPercent, 76);

	const idempotencyKey = "7bfb7c1d-e88a-44f3-b82e-f4b94fd68924";
	const consume = await consumeRateLimitResetCredit(idempotencyKey, options);
	assert.equal(consume.outcome, "reset");
	assert.deepEqual(JSON.parse(readFileSync(capturePath, "utf8")), { idempotencyKey });

	const unknownWindow: AccountRateLimits = {
		rateLimits: {
			primary: { usedPercent: 10 },
			secondary: { usedPercent: 91 },
		},
	};
	assert.equal(getWeeklyWindow(unknownWindow), undefined);

	const before: AccountRateLimits = {
		rateLimits: {
			primary: { usedPercent: 20, windowDurationMins: 300 },
			secondary: { usedPercent: 76, windowDurationMins: 10080 },
		},
		rateLimitResetCredits: { availableCount: 2 },
	};
	const after: AccountRateLimits = {
		rateLimits: {
			primary: { usedPercent: 0, windowDurationMins: 300 },
			secondary: { usedPercent: 0, windowDurationMins: 10080 },
		},
		rateLimitResetCredits: { availableCount: 1 },
	};

	let consumeCalls = 0;
	const cancelled = createContext(false);
	await createResetCodexHandler({
		readRateLimits: async () => before,
		consumeReset: async () => {
			consumeCalls++;
			return { outcome: "reset" };
		},
		createIdempotencyKey: () => "cancelled-key",
	})("", cancelled.ctx);
	assert.equal(cancelled.confirms, 1);
	assert.equal(consumeCalls, 0);

	const noCredit = createContext(true);
	await createResetCodexHandler({
		readRateLimits: async () => ({ ...before, rateLimitResetCredits: { availableCount: 0 } }),
		consumeReset: async () => {
			consumeCalls++;
			return { outcome: "reset" };
		},
		createIdempotencyKey: () => "no-credit-key",
	})("", noCredit.ctx);
	assert.equal(noCredit.confirms, 0);
	assert.equal(consumeCalls, 0);

	const succeeded = createContext(true);
	let reads = 0;
	let consumedKey: string | undefined;
	await createResetCodexHandler({
		readRateLimits: async () => (reads++ === 0 ? before : after),
		consumeReset: async key => {
			consumedKey = key;
			return { outcome: "reset" };
		},
		createIdempotencyKey: () => "stable-key",
	})("", succeeded.ctx);
	assert.equal(reads, 2);
	assert.equal(consumedKey, "stable-key");
	assert.match(succeeded.notifications.at(-1)?.message ?? "", /76% → 0%/);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log("pi-codex-reset smoke ok");
