import fs from "node:fs/promises";
import path from "node:path";
import spawn from "cross-spawn";
import { applyWorkspaceEdit } from "./edits.ts";
import { isAbortLike, LspAbortError, throwIfAborted } from "./errors.ts";
import { getLspmuxCommand, isLspmuxSupported } from "./lspmux.ts";
import { fileToUri } from "./path-utils.ts";
import type {
	LspClient,
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
	LspServerStatus,
	PublishDiagnosticsParams,
	ServerConfig,
	WorkspaceEdit,
} from "./types.ts";
import { detectLanguageId, sleep } from "./utils.ts";

const clients = new Map<string, LspClient>();
const clientLocks = new Map<string, Promise<LspClient>>();
const fileOperationLocks = new Map<string, Promise<void>>();
let idleTimeoutMs: number | null = null;
let idleCheckInterval: NodeJS.Timeout | null = null;
const IDLE_CHECK_INTERVAL_MS = 60_000;
export const WARMUP_TIMEOUT_MS = 5000;
const PROJECT_LOAD_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const EXIT_TIMEOUT_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const CLIENT_CAPABILITIES = {
	textDocument: {
		synchronization: { didSave: true, dynamicRegistration: false, willSave: false, willSaveWaitUntil: false },
		hover: { contentFormat: ["markdown", "plaintext"], dynamicRegistration: false },
		definition: { dynamicRegistration: false, linkSupport: true },
		typeDefinition: { dynamicRegistration: false, linkSupport: true },
		implementation: { dynamicRegistration: false, linkSupport: true },
		references: { dynamicRegistration: false },
		documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
		rename: { dynamicRegistration: false, prepareSupport: true },
		codeAction: {
			dynamicRegistration: false,
			codeActionLiteralSupport: {
				codeActionKind: {
					valueSet: [
						"quickfix",
						"refactor",
						"refactor.extract",
						"refactor.inline",
						"refactor.rewrite",
						"source",
						"source.organizeImports",
						"source.fixAll",
					],
				},
			},
			resolveSupport: { properties: ["edit"] },
		},
		formatting: { dynamicRegistration: false },
		publishDiagnostics: {
			relatedInformation: true,
			versionSupport: true,
			tagSupport: { valueSet: [1, 2] },
			codeDescriptionSupport: true,
			dataSupport: true,
		},
	},
	window: { workDoneProgress: true },
	workspace: {
		applyEdit: true,
		workspaceEdit: {
			documentChanges: true,
			resourceOperations: ["create", "rename", "delete"],
			failureHandling: "textOnlyTransactional",
		},
		configuration: true,
		workspaceFolders: true,
		symbol: { dynamicRegistration: false },
		fileOperations: { dynamicRegistration: false, willRename: true, didRename: true },
	},
	experimental: { snippetTextEdit: true },
};

export function setIdleTimeout(ms: number | null | undefined): void {
	idleTimeoutMs = ms ?? null;
	if (idleTimeoutMs && idleTimeoutMs > 0) {
		if (idleCheckInterval) return;
		idleCheckInterval = setInterval(() => {
			if (!idleTimeoutMs) return;
			const now = Date.now();
			for (const [key, client] of Array.from(clients.entries())) {
				if (now - client.lastActivity > idleTimeoutMs) void shutdownClient(key);
			}
		}, IDLE_CHECK_INTERVAL_MS);
	} else if (idleCheckInterval) {
		clearInterval(idleCheckInterval);
		idleCheckInterval = null;
	}
}

function currentWorkspaceFolders(client: LspClient): Array<{ uri: string; name: string }> {
	return [{ uri: fileToUri(client.cwd), name: path.basename(client.cwd) || "workspace" }];
}

function encodeMessage(message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse): string {
	const content = JSON.stringify(message);
	return `Content-Length: ${Buffer.byteLength(content, "utf8")}\r\n\r\n${content}`;
}

function queueWriteMessage(
	client: LspClient,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
): Promise<void> {
	const write = client.writeQueue
		.catch(() => {})
		.then(
			() =>
				new Promise<void>((resolve, reject) => {
					if (!client.proc.stdin) {
						reject(new Error("LSP stdin is closed"));
						return;
					}
					client.proc.stdin.write(encodeMessage(message), "utf8", (err) => (err ? reject(err) : resolve()));
				}),
		);
	client.writeQueue = write.catch(() => {});
	return write;
}

async function sendResponse(
	client: LspClient,
	id: number,
	result: unknown,
	error?: { code: number; message: string; data?: unknown },
): Promise<void> {
	await queueWriteMessage(client, { jsonrpc: "2.0", id, ...(error ? { error } : { result }) }).catch(() => {});
}

async function handleServerRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (typeof message.id !== "number") return;
	if (message.method === "workspace/configuration") {
		const params = message.params as { items?: Array<{ section?: string }> };
		await sendResponse(
			client,
			message.id,
			(params.items ?? []).map((item) => client.config.settings?.[item.section ?? ""] ?? {}),
		);
		return;
	}
	if (message.method === "workspace/workspaceFolders") {
		await sendResponse(client, message.id, currentWorkspaceFolders(client));
		return;
	}
	if (message.method === "workspace/applyEdit") {
		try {
			const params = message.params as { edit?: WorkspaceEdit };
			if (!params.edit) throw new Error("No edit provided");
			await applyWorkspaceEdit(params.edit, client.cwd);
			await sendResponse(client, message.id, { applied: true });
		} catch (err) {
			await sendResponse(client, message.id, { applied: false, failureReason: String(err) });
		}
		return;
	}
	if (message.method === "window/workDoneProgress/create") {
		await sendResponse(client, message.id, null);
		return;
	}
	await sendResponse(client, message.id, null, { code: -32601, message: `Method not found: ${message.method}` });
}

function processMessage(
	client: LspClient,
	message: LspJsonRpcResponse | LspJsonRpcNotification | LspJsonRpcRequest,
): void {
	if ("id" in message && message.id !== undefined && !("method" in message)) {
		const pending = client.pendingRequests.get(message.id);
		if (!pending) return;
		client.pendingRequests.delete(message.id);
		if (message.error) pending.reject(new Error(`LSP error: ${message.error.message}`));
		else pending.resolve(message.result);
		return;
	}
	if ("method" in message && "id" in message && message.id !== undefined) {
		void handleServerRequest(client, message as LspJsonRpcRequest);
		return;
	}
	if (!("method" in message)) return;
	if (message.method === "textDocument/publishDiagnostics" && message.params) {
		const params = message.params as PublishDiagnosticsParams;
		client.diagnostics.set(params.uri, { diagnostics: params.diagnostics, version: params.version ?? null });
		client.diagnosticsVersion += 1;
	} else if (message.method === "$/progress" && message.params) {
		const params = message.params as { token: string | number; value?: { kind?: string } };
		if (params.value?.kind === "begin") client.activeProgressTokens.add(params.token);
		if (params.value?.kind === "end") {
			client.activeProgressTokens.delete(params.token);
			if (client.activeProgressTokens.size === 0) client.resolveProjectLoaded();
		}
	}
}

function drainMessages(client: LspClient): void {
	while (true) {
		const headerEnd = client.messageBuffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		const header = client.messageBuffer.subarray(0, headerEnd).toString("utf8");
		const match = header.match(/Content-Length: (\d+)/i);
		if (!match) return;
		const length = Number.parseInt(match[1], 10);
		const start = headerEnd + 4;
		const end = start + length;
		if (client.messageBuffer.length < end) return;
		const text = client.messageBuffer.subarray(start, end).toString("utf8");
		client.messageBuffer = client.messageBuffer.subarray(end);
		processMessage(client, JSON.parse(text) as LspJsonRpcResponse | LspJsonRpcNotification | LspJsonRpcRequest);
	}
}

function attachReaders(client: LspClient, key: string): void {
	client.proc.stdout?.on("data", (chunk: Buffer) => {
		client.messageBuffer = Buffer.concat([client.messageBuffer, chunk]);
		drainMessages(client);
	});
	client.proc.on("exit", () => {
		clients.delete(key);
		clientLocks.delete(key);
		client.resolveProjectLoaded();
		const stderr = String(client.proc.stderr?.read() ?? "").trim();
		const err = new Error(stderr ? `LSP server exited: ${stderr}` : "LSP server exited unexpectedly");
		for (const pending of client.pendingRequests.values()) pending.reject(err);
		client.pendingRequests.clear();
	});
}

function commandBasename(command: string): string {
	const slash = command.lastIndexOf("/");
	const backslash = command.lastIndexOf("\\");
	const separator = Math.max(slash, backslash);
	return separator === -1 ? command : command.slice(separator + 1);
}

async function waitForRustAnalyzerWorkspace(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (
		commandBasename(client.config.command) !== "rust-analyzer" &&
		(!client.config.resolvedCommand || commandBasename(client.config.resolvedCommand) !== "rust-analyzer")
	)
		return;
	const timings = client.config.workspaceReadyTimings;
	const timeoutMs = timings?.timeoutMs ?? 5000;
	const pollMs = timings?.pollMs ?? 100;
	const settleMs = timings?.settleMs ?? 2000;
	const statusRequestTimeoutMs = timings?.statusRequestTimeoutMs ?? 1000;
	const started = Date.now();
	const deadline = started + timeoutMs;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		try {
			const status = await sendRequest(client, "rust-analyzer/analyzerStatus", {}, signal, statusRequestTimeoutMs);
			if (typeof status === "string" && !status.startsWith("No workspaces") && Date.now() - started >= settleMs)
				return;
		} catch {}
		await sleep(pollMs, signal);
	}
}

export async function getOrCreateClient(config: ServerConfig, cwd: string, initTimeoutMs?: number): Promise<LspClient> {
	const key = `${config.command}:${cwd}`;
	const existing = clients.get(key);
	if (existing) {
		existing.lastActivity = Date.now();
		return existing;
	}
	const existingLock = clientLocks.get(key);
	if (existingLock) return existingLock;
	const promise = (async () => {
		const baseCommand = config.resolvedCommand ?? config.command;
		const baseArgs = config.args ?? [];
		const commandInfo = isLspmuxSupported(baseCommand)
			? await getLspmuxCommand(baseCommand, baseArgs)
			: { command: baseCommand, args: baseArgs };
		const proc = spawn(commandInfo.command, commandInfo.args, {
			cwd,
			env: commandInfo.env ? { ...process.env, ...commandInfo.env } : process.env,
		});
		let resolveProjectLoaded = () => {};
		const projectLoaded = new Promise<void>((resolve) => {
			resolveProjectLoaded = resolve;
		});
		const projectLoadTimeout = setTimeout(resolveProjectLoaded, PROJECT_LOAD_TIMEOUT_MS);
		const originalResolve = resolveProjectLoaded;
		resolveProjectLoaded = () => {
			clearTimeout(projectLoadTimeout);
			originalResolve();
		};
		const client: LspClient = {
			name: key,
			cwd,
			config,
			proc,
			requestId: 0,
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			openFiles: new Map(),
			pendingRequests: new Map(),
			messageBuffer: Buffer.alloc(0),
			lastActivity: Date.now(),
			writeQueue: Promise.resolve(),
			activeProgressTokens: new Set(),
			projectLoaded,
			resolveProjectLoaded,
		};
		clients.set(key, client);
		attachReaders(client, key);
		try {
			const initResult = (await sendRequest(
				client,
				"initialize",
				{
					processId: process.pid,
					rootUri: fileToUri(cwd),
					rootPath: cwd,
					capabilities: CLIENT_CAPABILITIES,
					initializationOptions: config.initOptions ?? {},
					workspaceFolders: currentWorkspaceFolders(client),
				},
				undefined,
				initTimeoutMs,
			)) as { capabilities?: unknown };
			client.serverCapabilities = initResult.capabilities as LspClient["serverCapabilities"];
			await sendNotification(client, "initialized", {});
			return client;
		} catch (err) {
			clients.delete(key);
			proc.kill();
			throw err;
		} finally {
			clientLocks.delete(key);
		}
	})();
	clientLocks.set(key, promise);
	return promise;
}

export async function ensureFileOpen(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	if (client.openFiles.has(uri)) return;
	const lockKey = `${client.name}:${uri}`;
	const lock = fileOperationLocks.get(lockKey);
	if (lock) {
		await lock;
		return;
	}
	const promise = (async () => {
		if (client.openFiles.has(uri)) return;
		const content = await fs.readFile(filePath, "utf8");
		throwIfAborted(signal);
		await sendNotification(client, "textDocument/didOpen", {
			textDocument: { uri, languageId: detectLanguageId(filePath), version: 1, text: content },
		});
		client.openFiles.set(uri, { version: 1, languageId: detectLanguageId(filePath) });
		client.lastActivity = Date.now();
	})();
	fileOperationLocks.set(lockKey, promise);
	try {
		await promise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

export async function syncContent(
	client: LspClient,
	filePath: string,
	content: string,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	client.diagnostics.delete(uri);
	const info = client.openFiles.get(uri);
	if (!info) {
		await sendNotification(client, "textDocument/didOpen", {
			textDocument: { uri, languageId: detectLanguageId(filePath), version: 1, text: content },
		});
		client.openFiles.set(uri, { version: 1, languageId: detectLanguageId(filePath) });
	} else {
		const version = ++info.version;
		await sendNotification(client, "textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text: content }],
		});
	}
	client.lastActivity = Date.now();
}

export async function notifySaved(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	if (!client.openFiles.has(uri)) return;
	await sendNotification(client, "textDocument/didSave", { textDocument: { uri } });
	client.lastActivity = Date.now();
}

export async function refreshFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	client.diagnostics.delete(uri);
	const info = client.openFiles.get(uri);
	if (!info) {
		await ensureFileOpen(client, filePath, signal);
		return;
	}
	const content = await fs.readFile(filePath, "utf8");
	const version = ++info.version;
	await sendNotification(client, "textDocument/didChange", {
		textDocument: { uri, version },
		contentChanges: [{ text: content }],
	});
	await sendNotification(client, "textDocument/didSave", { textDocument: { uri }, text: content });
	client.lastActivity = Date.now();
}

export async function waitForProjectLoaded(client: LspClient, signal?: AbortSignal): Promise<void> {
	await Promise.race([
		client.projectLoaded,
		signal
			? new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
			: Promise.resolve(),
	]);
	await waitForRustAnalyzerWorkspace(client, signal);
}

export async function sendRequest(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<unknown> {
	if (signal?.aborted) throw new LspAbortError();
	const id = ++client.requestId;
	client.lastActivity = Date.now();
	const request: LspJsonRpcRequest = { jsonrpc: "2.0", id, method, params };
	let resolve!: (value: unknown) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	let timeout: NodeJS.Timeout | undefined;
	const cleanup = () => {
		if (timeout) clearTimeout(timeout);
		if (signal) signal.removeEventListener("abort", abortHandler);
	};
	const abortHandler = () => {
		client.pendingRequests.delete(id);
		void sendNotification(client, "$/cancelRequest", { id }).catch(() => {});
		cleanup();
		reject(new LspAbortError());
	};
	const effectiveTimeoutMs = timeoutMs ?? (signal ? undefined : DEFAULT_REQUEST_TIMEOUT_MS);
	if (effectiveTimeoutMs !== undefined) {
		timeout = setTimeout(() => {
			client.pendingRequests.delete(id);
			cleanup();
			reject(new Error(`LSP request ${method} timed out after ${effectiveTimeoutMs}ms`));
		}, effectiveTimeoutMs);
	}
	if (signal) signal.addEventListener("abort", abortHandler, { once: true });
	client.pendingRequests.set(id, {
		method,
		resolve: (result) => {
			cleanup();
			resolve(result);
		},
		reject: (err) => {
			cleanup();
			reject(err);
		},
	});
	queueWriteMessage(client, request).catch((err) => {
		client.pendingRequests.delete(id);
		cleanup();
		reject(err);
	});
	return promise;
}

export async function sendNotification(client: LspClient, method: string, params: unknown): Promise<void> {
	await queueWriteMessage(client, { jsonrpc: "2.0", method, params });
	client.lastActivity = Date.now();
}

async function waitForExit(client: LspClient, timeoutMs: number): Promise<boolean> {
	return await Promise.race([
		new Promise<boolean>((resolve) => client.proc.once("exit", () => resolve(true))),
		sleep(timeoutMs).then(() => false),
	]);
}

async function shutdownClientInstance(client: LspClient): Promise<void> {
	const err = new Error("LSP client shutdown");
	for (const pending of client.pendingRequests.values()) pending.reject(err);
	client.pendingRequests.clear();
	const shutdownCompleted = await sendRequest(client, "shutdown", null, undefined, SHUTDOWN_TIMEOUT_MS).then(
		() => true,
		() => false,
	);
	if (shutdownCompleted) {
		await sendNotification(client, "exit", undefined).catch(() => {});
		if (await waitForExit(client, EXIT_TIMEOUT_MS)) return;
	}
	client.proc.kill();
	await waitForExit(client, EXIT_TIMEOUT_MS);
}

export async function shutdownClient(key: string): Promise<void> {
	const client = clients.get(key);
	if (!client) return;
	clients.delete(key);
	await shutdownClientInstance(client);
}

export async function shutdownAll(): Promise<void> {
	const active = Array.from(clients.values());
	clients.clear();
	await Promise.allSettled(active.map((client) => shutdownClientInstance(client)));
}

export function getActiveClients(): LspServerStatus[] {
	return Array.from(clients.values()).map((client) => ({
		name: client.config.command,
		status: "ready",
		fileTypes: client.config.fileTypes,
	}));
}

export { isAbortLike };
