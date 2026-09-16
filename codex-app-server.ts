import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type RateLimitWindow = {
	usedPercent: number;
	windowDurationMins?: number | null;
	resetsAt?: number | null;
};

export type RateLimitSnapshot = {
	limitId?: string | null;
	limitName?: string | null;
	primary?: RateLimitWindow | null;
	secondary?: RateLimitWindow | null;
};

export type AccountRateLimits = {
	rateLimits: RateLimitSnapshot;
	rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
	rateLimitResetCredits?: {
		availableCount: number;
	} | null;
};

export type ResetOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

export type ConsumeResetResponse = {
	outcome: ResetOutcome;
};

export type CodexAppServerOptions = {
	command?: string;
	args?: string[];
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

type RpcResponse = {
	id?: number | string;
	result?: unknown;
	error?: {
		code?: number;
		message?: string;
		data?: unknown;
	};
};

const CLIENT_INFO = {
	name: "pi-codex-reset",
	title: "Pi Codex Reset",
	version: "0.1.0",
};
const DEFAULT_TIMEOUT_MS = 15_000;
const WEEK_MINUTES = 7 * 24 * 60;
const WEEK_TOLERANCE_MINUTES = 5;
const STDERR_LIMIT = 8_192;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function rpcErrorMessage(error: NonNullable<RpcResponse["error"]>): string {
	const code = typeof error.code === "number" ? ` (${error.code})` : "";
	return `${error.message ?? "Codex App Server request failed"}${code}`;
}

export class CodexAppServerClient {
	private readonly command: string;
	private readonly args: string[];
	private readonly timeoutMs: number;
	private readonly env: NodeJS.ProcessEnv;
	private child?: ChildProcessWithoutNullStreams;
	private startPromise?: Promise<void>;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private nextId = 0;
	private readonly pending = new Map<number, PendingRequest>();
	private closed = false;

	constructor(options: CodexAppServerOptions = {}) {
		this.command = options.command ?? process.env.CODEX_BIN ?? "codex";
		this.args = options.args ?? [];
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.env = options.env ?? process.env;
	}

	start(): Promise<void> {
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.initialize();
		return this.startPromise;
	}

	async request<T>(method: string, params?: unknown): Promise<T> {
		await this.start();
		return this.requestRaw<T>(method, params);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const child = this.child;
		if (!child) return;

		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Codex App Server connection closed"));
		}
		this.pending.clear();

		if (child.exitCode !== null || child.signalCode !== null) return;
		child.stdin.end();
		child.kill("SIGTERM");
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				resolve();
			}, 500);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private async initialize(): Promise<void> {
		if (this.closed) throw new Error("Codex App Server client is closed");
		const child = spawn(this.command, [...this.args, "app-server"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: this.env,
		});
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", chunk => this.handleStdout(String(chunk)));
		child.stderr.on("data", chunk => {
			this.stderrBuffer = (this.stderrBuffer + String(chunk)).slice(-STDERR_LIMIT);
		});
		child.once("error", error => this.failAll(new Error(`Codexを起動できません: ${error.message}`)));
		child.once("exit", (code, signal) => {
			if (this.closed) return;
			const detail = this.stderrBuffer.trim();
			const suffix = detail ? `: ${detail}` : "";
			this.failAll(new Error(`Codex App Serverが終了しました (code=${code}, signal=${signal})${suffix}`));
		});

		try {
			await this.requestRaw("initialize", { clientInfo: CLIENT_INFO });
			this.send({ method: "initialized", params: {} });
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	private requestRaw<T>(method: string, params?: unknown): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Codex App Serverが${this.timeoutMs}ms以内に応答しませんでした: ${method}`));
			}, this.timeoutMs);
			this.pending.set(id, {
				resolve: value => resolve(value as T),
				reject,
				timer,
			});
			try {
				this.send(params === undefined ? { method, id } : { method, id, params });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(`Codex App Serverへの送信に失敗しました: ${errorMessage(error)}`));
			}
		});
	}

	private send(message: unknown): void {
		const child = this.child;
		if (!child || child.stdin.destroyed || !child.stdin.writable) {
			throw new Error("Codex App Serverの標準入力を利用できません");
		}
		child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private handleStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		while (true) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (line.trim() === "") continue;
			let message: RpcResponse;
			try {
				message = JSON.parse(line) as RpcResponse;
			} catch (error) {
				this.failAll(new Error(`Codex App Serverから不正なJSONを受信しました: ${errorMessage(error)}`));
				continue;
			}
			if (typeof message.id !== "number") continue;
			const pending = this.pending.get(message.id);
			if (!pending) continue;
			clearTimeout(pending.timer);
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(rpcErrorMessage(message.error)));
			else pending.resolve(message.result);
		}
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

async function runCodexRequest<T>(method: string, params: unknown, options: CodexAppServerOptions): Promise<T> {
	const client = new CodexAppServerClient(options);
	try {
		return await client.request<T>(method, params);
	} finally {
		await client.close();
	}
}

export function readAccountRateLimits(options: CodexAppServerOptions = {}): Promise<AccountRateLimits> {
	return runCodexRequest<AccountRateLimits>("account/rateLimits/read", undefined, options);
}

export function consumeRateLimitResetCredit(
	idempotencyKey: string,
	options: CodexAppServerOptions = {},
): Promise<ConsumeResetResponse> {
	return runCodexRequest<ConsumeResetResponse>(
		"account/rateLimitResetCredit/consume",
		{ idempotencyKey },
		options,
	);
}

export function getWeeklyWindow(rateLimits: AccountRateLimits): RateLimitWindow | undefined {
	const snapshots: RateLimitSnapshot[] = [];
	const byId = rateLimits.rateLimitsByLimitId;
	if (byId?.codex) snapshots.push(byId.codex);
	if (byId) {
		for (const [id, snapshot] of Object.entries(byId)) {
			if (id !== "codex") snapshots.push(snapshot);
		}
	}
	if (!snapshots.includes(rateLimits.rateLimits)) snapshots.push(rateLimits.rateLimits);

	for (const snapshot of snapshots) {
		for (const window of [snapshot.primary, snapshot.secondary]) {
			if (!window || typeof window.windowDurationMins !== "number") continue;
			if (Math.abs(window.windowDurationMins - WEEK_MINUTES) <= WEEK_TOLERANCE_MINUTES) return window;
		}
	}

	return undefined;
}
