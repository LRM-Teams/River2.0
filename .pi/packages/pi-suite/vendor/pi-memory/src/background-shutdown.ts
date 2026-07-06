/**
 * Background (detached) session shutdown workload.
 *
 * Runs inside a standalone Node process spawned by the memory extension's
 * `session_shutdown` handler when `PI_MEMORY_BACKGROUND_SHUTDOWN` is active
 * (default: `auto`, i.e. print/json modes). The main pi process can exit
 * immediately while this worker performs the heavy final-exit workload:
 * exit summary, learning extractor, curator, qmd update, sync upload.
 *
 * The worker does NOT receive a live ExtensionContext. Instead it reads the
 * session JSONL from disk (`readSessionEntriesFromJsonl`) and reconstructs a
 * minimal ctx shim whose `sessionManager.getBranch()` returns the parsed
 * entries and whose `model`/`modelRegistry` are rebuilt from a serialized
 * model blob + an API key handed over via the `__PI_MEMORY_BG_KEY` env var.
 *
 * Memory still lands in the correct agent directory because the worker
 * inherits `PI_AGENT_ROOT` / `PI_MEMORY_DIR` from the parent's `process.env`.
 */
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { runFinalExitWorkload, readSessionEntriesFromJsonl, type ExitSummaryReason } from "../index.ts";

export type BackgroundShutdownPayload = {
	sessionFile: string;
	sessionId: string;
	reason: ExitSummaryReason | "session-end";
	/** Serialized `Model` object (JSON string) from the parent, or null. */
	model: string | null;
};

/** Read and parse the JSON payload left by the parent process. */
export function readPayload(payloadPath: string): BackgroundShutdownPayload {
	const raw = fs.readFileSync(payloadPath, "utf-8");
	return JSON.parse(raw) as BackgroundShutdownPayload;
}

type MinimalModel = {
	id: string;
	name?: string;
	api?: string;
	provider?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: string[];
	cost?: Record<string, number>;
	contextWindow?: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	[key: string]: unknown;
};

/**
 * Build a minimal ExtensionContext shim from on-disk data so the existing
 * shutdown workload functions (which read `ctx.sessionManager.getBranch()`,
 * `ctx.model`, `ctx.modelRegistry.getApiKey()`) work unchanged.
 */
export function buildDetachedCtxShim(payload: BackgroundShutdownPayload, apiKey: string | undefined): ExtensionContext {
	const entries: SessionEntry[] = readSessionEntriesFromJsonl(payload.sessionFile);
	const model = payload.model ? (JSON.parse(payload.model) as MinimalModel) : undefined;

	const sessionManager = {
		getBranch: () => entries,
		getSessionFile: () => payload.sessionFile,
		getSessionId: () => payload.sessionId,
		getCwd: () => process.cwd(),
		getSessionDir: () => "",
		getLeafId: () => undefined,
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getHeader: () => undefined,
		getEntries: () => entries,
		getTree: () => [],
		getSessionName: () => undefined,
	};

	const modelRegistry = {
		getApiKey: async () => apiKey,
		getApiKeyForProvider: async () => apiKey,
	};

	const shim = {
		ui: { notify() {} },
		mode: "json" as const,
		hasUI: false,
		cwd: process.cwd(),
		sessionManager,
		modelRegistry,
		model,
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort() {},
		hasPendingMessages: () => false,
		shutdown() {},
		getContextUsage: () => undefined,
		compact() {},
		getSystemPrompt: () => "",
	};

	return shim as unknown as ExtensionContext;
}

/**
 * Run the full final-exit memory workload in this detached process.
 * Errors are swallowed (and logged to audit) so the worker always exits 0
 * regardless of transient LLM/qmd failures — the parent already returned.
 */
export async function runBackgroundShutdown(payload: BackgroundShutdownPayload, apiKey: string | undefined): Promise<void> {
	const ctx = buildDetachedCtxShim(payload, apiKey);
	await runFinalExitWorkload(ctx, payload.reason);
}
