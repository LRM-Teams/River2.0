import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	ensureFileOpen,
	getActiveClients,
	getOrCreateClient,
	notifySaved,
	refreshFile,
	sendNotification,
	sendRequest,
	setIdleTimeout,
	shutdownAll,
	syncContent,
	waitForProjectLoaded,
} from "./client.ts";
import { getFirstServerForFile, getLspServers, getServersForFile, type LspConfig, loadConfig } from "./config.ts";
import {
	applyTextEdits,
	applyWorkspaceEdit,
	flattenWorkspaceTextEdits,
	formatWorkspaceEdit,
	rangesOverlap,
} from "./edits.ts";
import { isAbortLike, LspToolError } from "./errors.ts";
import { detectLspmux } from "./lspmux.ts";
import { fileToUri, formatPathRelativeToCwd, resolveToCwd, uriToFile } from "./path-utils.ts";
import type {
	CodeAction,
	CodeActionContext,
	Command,
	Diagnostic,
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	LspParams,
	LspToolDetails,
	ServerConfig,
	SymbolInformation,
	TextEdit,
	WorkspaceEdit,
} from "./types.ts";
import { lspSchema } from "./types.ts";
import {
	applyCodeAction,
	dedupeWorkspaceSymbols,
	enumerateRenamePairs,
	extractHoverText,
	filterWorkspaceSymbols,
	formatCodeAction,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatDocumentSymbol,
	formatGroupedDiagnosticMessages,
	formatLocation,
	formatLocationWithContext,
	formatSymbolInformation,
	isOnlyQueriedDeclaration,
	normalizeLocationResult,
	resolveDiagnosticTargets,
	resolveSymbolColumn,
	runWorkspaceDiagnostics,
	sleep,
	sortDiagnostics,
	symbolKindToIcon,
} from "./utils.ts";

const LSP_DESCRIPTION = `Interacts with Language Server Protocol servers for code intelligence.

Operations:
- diagnostics: Get errors/warnings for a file, glob, or workspace (file: "*")
- definition, type_definition, implementation, references: symbol navigation with source context
- hover: Get type info and documentation
- symbols: List document symbols or search workspace symbols with file: "*" and query
- rename: Rename a symbol across the codebase; preview with apply=false
- rename_file: Rename or move a file/directory and ask language servers to update references/imports
- code_actions: List quick fixes/refactors/import actions; apply one with apply=true and query
- status, capabilities, request, reload: inspect, send raw request, or restart servers

Requires installed language servers. Use lsp status first when unsure.`;

const READONLY_ACTIONS = new Set([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"symbols",
	"status",
	"capabilities",
]);
const PROJECT_INDEXED_ACTIONS = new Set(["definition", "type_definition", "implementation", "references", "rename"]);
const MAX_GLOB_DIAGNOSTIC_TARGETS = 20;
const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 2000;
const WORKSPACE_SYMBOL_LIMIT = 50;
const REFERENCE_CONTEXT_LIMIT = 50;
const REFERENCES_RETRY_COUNT = 2;
const REFERENCES_RETRY_DELAY_MS = 300;
const MAX_RENAME_PAIRS = 1000;

const configCache = new Map<string, LspConfig>();

function getConfig(cwd: string): LspConfig {
	let config = configCache.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		setIdleTimeout(config.idleTimeoutMs);
		configCache.set(cwd, config);
	}
	return config;
}

export function configCacheClear(cwd?: string): void {
	if (cwd) configCache.delete(cwd);
	else configCache.clear();
}

function clampTimeout(timeout: number | undefined): number {
	if (timeout === undefined || Number.isNaN(timeout)) return 20;
	return Math.max(5, Math.min(60, timeout));
}

function result(
	action: string,
	text: string,
	success: boolean,
	request?: LspParams,
	serverName?: string,
): AgentToolResult<LspToolDetails> {
	return { content: [{ type: "text", text }], details: { action, success, request, serverName } };
}

function isProjectAwareLspServer(config: ServerConfig): boolean {
	const command = path.basename(config.command);
	return [
		"rust-analyzer",
		"gopls",
		"typescript-language-server",
		"pyright-langserver",
		"basedpyright-langserver",
		"clangd",
		"jdtls",
	].includes(command);
}

function isMethodNotFoundError(err: unknown): boolean {
	return err instanceof Error && /method not found|not implemented|unsupported/i.test(err.message);
}

async function waitForDiagnostics(
	client: {
		diagnostics: Map<string, { diagnostics: Diagnostic[]; version: number | null }>;
		diagnosticsVersion: number;
	},
	uri: string,
	options: { timeoutMs: number; signal?: AbortSignal; minVersion: number; expectedDocumentVersion?: number },
): Promise<Diagnostic[]> {
	const started = Date.now();
	while (Date.now() - started < options.timeoutMs) {
		if (options.signal?.aborted) break;
		const published = client.diagnostics.get(uri);
		if (published && client.diagnosticsVersion > options.minVersion) {
			if (
				options.expectedDocumentVersion === undefined ||
				published.version === null ||
				published.version === options.expectedDocumentVersion
			) {
				return published.diagnostics;
			}
		}
		await sleep(100, options.signal).catch(() => {});
	}
	return client.diagnostics.get(uri)?.diagnostics ?? [];
}

async function diagnosticsForFile(
	cwd: string,
	config: LspConfig,
	filePath: string,
	timeoutSec: number,
	signal?: AbortSignal,
): Promise<{ diagnostics: Diagnostic[]; serverNames: string[] }> {
	const servers = getServersForFile(config, filePath);
	const allDiagnostics: Diagnostic[] = [];
	const serverNames: string[] = [];
	for (const [serverName, serverConfig] of servers) {
		serverNames.push(serverName);
		try {
			const client = await getOrCreateClient(serverConfig, cwd);
			if (isProjectAwareLspServer(serverConfig)) await waitForProjectLoaded(client, signal);
			const uri = fileToUri(filePath);
			const minVersion = client.diagnosticsVersion;
			await refreshFile(client, filePath, signal);
			const expectedDocumentVersion = client.openFiles.get(uri)?.version;
			const diagnostics = await waitForDiagnostics(client, uri, {
				timeoutMs: Math.min(SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000),
				signal,
				minVersion,
				expectedDocumentVersion,
			});
			allDiagnostics.push(...diagnostics);
		} catch (err) {
			if (isAbortLike(err, signal)) throw err;
		}
	}
	const seen = new Set<string>();
	const unique = allDiagnostics.filter((diagnostic) => {
		const key = `${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.range.end.line}:${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	sortDiagnostics(unique);
	return { diagnostics: unique, serverNames };
}

async function handleDiagnostics(
	cwd: string,
	config: LspConfig,
	params: LspParams,
	timeoutSec: number,
	signal?: AbortSignal,
): Promise<AgentToolResult<LspToolDetails>> {
	const { action, file } = params;
	if (file === "*") {
		const output = await runWorkspaceDiagnostics(cwd, async (target) => {
			const servers = getServersForFile(config, target);
			if (servers.length === 0) return [];
			return (await diagnosticsForFile(cwd, config, target, timeoutSec, signal)).diagnostics;
		});
		return result(action, `Workspace diagnostics:\n${output}`, true, params);
	}
	if (!file)
		return result(action, "Error: file parameter required. Use `*` for workspace diagnostics.", false, params);
	const resolvedTargets = await resolveDiagnosticTargets(file, cwd, MAX_GLOB_DIAGNOSTIC_TARGETS);
	if (resolvedTargets.matches.length === 0) return result(action, `No files matched pattern: ${file}`, true, params);
	const lines: string[] = [];
	if (resolvedTargets.truncated)
		lines.push(
			`Pattern matched more than ${MAX_GLOB_DIAGNOSTIC_TARGETS} files; showing first ${MAX_GLOB_DIAGNOSTIC_TARGETS}.`,
		);
	const serverNames = new Set<string>();
	for (const target of resolvedTargets.matches) {
		const servers = getServersForFile(config, target);
		const relPath = formatPathRelativeToCwd(target, cwd);
		if (servers.length === 0) {
			lines.push(`${relPath}: No language server found`);
			continue;
		}
		const fileResult = await diagnosticsForFile(cwd, config, target, timeoutSec, signal);
		for (const name of fileResult.serverNames) serverNames.add(name);
		if (fileResult.diagnostics.length === 0) {
			if (resolvedTargets.matches.length === 1 && !resolvedTargets.truncated)
				return result(action, "OK", true, params, Array.from(serverNames).join(", "));
			lines.push(`${relPath}: no issues`);
		} else {
			lines.push(`${relPath}: ${formatDiagnosticsSummary(fileResult.diagnostics)}`);
			lines.push(
				formatGroupedDiagnosticMessages(
					fileResult.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic, relPath)),
				),
			);
		}
	}
	return result(action, lines.join("\n"), true, params, Array.from(serverNames).join(", "));
}

async function handleStatus(
	_cwd: string,
	config: LspConfig,
	params: LspParams,
): Promise<AgentToolResult<LspToolDetails>> {
	const configuredNames = Object.keys(config.servers);
	const startedClients = getActiveClients();
	const lspmuxState = await detectLspmux();
	const lines: string[] = [];
	if (configuredNames.length === 0) lines.push("No language servers configured for this project");
	else {
		lines.push(
			`Language servers: ${configuredNames
				.map((name) => {
					const server = config.servers[name];
					const started = startedClients.find((client) => client.name === server.command);
					return started ? `${name} (${started.status})` : `${name} (configured, not started)`;
				})
				.join(", ")}`,
		);
		lines.push(
			"  note: configured means the binary resolves on PATH and project markers match; ready means a live client process exists.",
		);
	}
	if (lspmuxState.available)
		lines.push(lspmuxState.running ? "lspmux: active" : "lspmux: installed but server not running");
	return result(params.action, lines.join("\n"), true, params);
}

async function handleRenameFile(
	cwd: string,
	config: LspConfig,
	params: LspParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<LspToolDetails>> {
	const { action, file, new_name, apply } = params;
	if (!file || !new_name)
		return result(action, "Error: rename_file requires both `file` and `new_name`", false, params);
	const source = resolveToCwd(file, cwd);
	const dest = resolveToCwd(new_name, cwd);
	if (source === dest) return result(action, "Error: source and destination paths are identical", false, params);
	let stat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stat = await fs.stat(source);
	} catch {
		return result(
			action,
			`Error: source path does not exist: ${formatPathRelativeToCwd(source, cwd)}`,
			false,
			params,
		);
	}
	try {
		await fs.stat(dest);
		return result(action, `Error: destination already exists: ${formatPathRelativeToCwd(dest, cwd)}`, false, params);
	} catch {}
	const enumerated = await enumerateRenamePairs(source, dest, MAX_RENAME_PAIRS);
	if (enumerated.exceeded)
		return result(action, `Error: directory contains more than ${MAX_RENAME_PAIRS} files`, false, params);
	const pairs = enumerated.pairs;
	const lspParams = { files: pairs };
	const relevantNames = new Set<string>();
	for (const pair of pairs) {
		for (const [name] of getServersForFile(config, uriToFile(pair.oldUri))) relevantNames.add(name);
		for (const [name] of getServersForFile(config, uriToFile(pair.newUri))) relevantNames.add(name);
	}
	const servers = getLspServers(config).filter(([name]) => relevantNames.has(name));
	const perServerEdits: Array<{ serverName: string; edit: WorkspaceEdit }> = [];
	const respondingServers = new Set<string>();
	const serverNotes: string[] = [];
	for (const [serverName, serverConfig] of servers) {
		try {
			const client = await getOrCreateClient(serverConfig, cwd);
			if (isProjectAwareLspServer(serverConfig)) await waitForProjectLoaded(client, signal);
			const edit = (await sendRequest(
				client,
				"workspace/willRenameFiles",
				lspParams,
				signal,
			)) as WorkspaceEdit | null;
			respondingServers.add(serverName);
			if (edit?.changes || edit?.documentChanges) perServerEdits.push({ serverName, edit });
		} catch (err) {
			if (isAbortLike(err, signal)) throw err;
			if (!isMethodNotFoundError(err))
				serverNotes.push(`  ${serverName}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	const sourceLabel = formatPathRelativeToCwd(source, cwd);
	const destLabel = formatPathRelativeToCwd(dest, cwd);
	const fileCountLabel = stat.isDirectory()
		? `${pairs.length} file${pairs.length === 1 ? "" : "s"} under ${sourceLabel}`
		: sourceLabel;
	if (apply === false) {
		const lines = [`Rename preview: ${fileCountLabel} -> ${destLabel}`];
		if (perServerEdits.length === 0) lines.push("  No LSP edits would be applied");
		for (const { serverName, edit } of perServerEdits) {
			lines.push(`  ${serverName}:`);
			lines.push(...formatWorkspaceEdit(edit, cwd).map((line) => `    ${line}`));
		}
		if (serverNotes.length > 0) lines.push("  Server notes:", ...serverNotes);
		return result(action, lines.join("\n"), true, params, Array.from(respondingServers).join(", "));
	}
	const acceptedByUri = new Map<
		string,
		{ primaryServer: string; edits: TextEdit[]; discarded: number; conflictServers: Set<string> }
	>();
	for (const { serverName, edit } of perServerEdits) {
		const incomingPrimary = isProjectAwareLspServer(config.servers[serverName]);
		for (const [uri, edits] of flattenWorkspaceTextEdits(edit)) {
			const existing = acceptedByUri.get(uri);
			if (!existing) {
				acceptedByUri.set(uri, {
					primaryServer: serverName,
					edits: [...edits],
					discarded: 0,
					conflictServers: new Set(),
				});
				continue;
			}
			const existingPrimary = isProjectAwareLspServer(config.servers[existing.primaryServer]);
			if (incomingPrimary && !existingPrimary) {
				const kept = existing.edits.filter(
					(oldEdit) => !edits.some((newEdit) => rangesOverlap(newEdit.range, oldEdit.range)),
				);
				existing.discarded += existing.edits.length - kept.length;
				existing.primaryServer = serverName;
				existing.edits = [...edits, ...kept];
			} else {
				for (const edit of edits) {
					if (existing.edits.some((accepted) => rangesOverlap(accepted.range, edit.range))) {
						existing.discarded++;
						existing.conflictServers.add(serverName);
					} else existing.edits.push(edit);
				}
			}
		}
	}
	const summary: string[] = [];
	for (const [uri, bucket] of acceptedByUri) {
		const filePath = uriToFile(uri);
		await applyTextEdits(filePath, bucket.edits);
		summary.push(
			`  ${bucket.primaryServer}: applied ${bucket.edits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`,
		);
	}
	await fs.mkdir(path.dirname(dest), { recursive: true });
	await fs.rename(source, dest);
	summary.push(`  Renamed ${sourceLabel} -> ${destLabel}`);
	for (const [, serverConfig] of servers) {
		try {
			const client = await getOrCreateClient(serverConfig, cwd);
			for (const { oldUri } of pairs) {
				if (client.openFiles.has(oldUri)) {
					await sendNotification(client, "textDocument/didClose", { textDocument: { uri: oldUri } });
					client.openFiles.delete(oldUri);
				}
			}
			await sendNotification(client, "workspace/didRenameFiles", lspParams);
		} catch (err) {
			if (isAbortLike(err, signal)) throw err;
		}
	}
	return result(
		action,
		`Renamed ${fileCountLabel} -> ${destLabel}\n${summary.join("\n")}`,
		true,
		params,
		Array.from(respondingServers).join(", "),
	);
}

export function createLspToolDefinition(cwd: string): ToolDefinition<typeof lspSchema, LspToolDetails> {
	return defineTool({
		name: "lsp",
		label: "LSP",
		description: LSP_DESCRIPTION,
		promptSnippet:
			"Query Language Server Protocol servers for diagnostics, hover info, definitions, references, symbols, rename, and code actions",
		promptGuidelines: [
			"Use lsp for symbol-aware operations such as rename, references, definitions, implementations, hover, and code actions whenever a language server is available.",
			"Use lsp diagnostics after editing files covered by a configured language server.",
			"Never perform cross-file symbol renames with text replacement when lsp rename can do it safely.",
		],
		parameters: lspSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<LspToolDetails>> {
			const timeoutSec = clampTimeout(params.timeout);
			const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			try {
				return await executeLsp(cwd, params, timeoutSec, combinedSignal);
			} catch (err) {
				if (timeoutSignal.aborted && !signal?.aborted)
					throw new LspToolError(
						`LSP ${params.action} timed out after ${timeoutSec}s. The server may still be indexing; retry or pass a larger timeout.`,
					);
				if (err instanceof LspToolError) throw err;
				if (isAbortLike(err, signal)) throw new Error("Operation aborted");
				return result(
					params.action,
					`LSP error: ${err instanceof Error ? err.message : String(err)}`,
					false,
					params,
				);
			}
		},
	});
}

async function executeLsp(
	cwd: string,
	params: LspParams,
	timeoutSec: number,
	signal?: AbortSignal,
): Promise<AgentToolResult<LspToolDetails>> {
	const config = getConfig(cwd);
	const { action, file, line, symbol, query, new_name, apply } = params;
	if (action === "status") return handleStatus(cwd, config, params);
	if (action === "diagnostics") return handleDiagnostics(cwd, config, params, timeoutSec, signal);
	if (action === "rename_file") return handleRenameFile(cwd, config, params, signal);
	if (action === "capabilities") {
		const servers = file && file !== "*" ? getServersForFile(config, resolveToCwd(file, cwd)) : getLspServers(config);
		if (servers.length === 0)
			return result(
				action,
				file ? "No language server found for this file" : "No language servers configured",
				false,
				params,
			);
		const sections: string[] = [];
		const responding = new Set<string>();
		for (const [serverName, serverConfig] of servers) {
			try {
				const client = await getOrCreateClient(serverConfig, cwd);
				responding.add(serverName);
				sections.push(
					`${serverName}:\n  capabilities: ${JSON.stringify(client.serverCapabilities ?? {}, null, 2)
						.split("\n")
						.join("\n  ")}`,
				);
			} catch (err) {
				sections.push(`${serverName}: failed to start (${err instanceof Error ? err.message : String(err)})`);
			}
		}
		return result(action, sections.join("\n"), true, params, Array.from(responding).join(", "));
	}
	if (action === "request") return handleRawRequest(cwd, config, params, signal);
	const isWorkspace = file === "*";
	if (action === "symbols" && isWorkspace) return handleWorkspaceSymbols(cwd, config, params, signal);
	if (action === "reload" && (!file || isWorkspace)) {
		await shutdownAll();
		configCache.delete(cwd);
		return result(action, "Reloaded all LSP servers", true, params);
	}
	if (!file)
		return result(
			action,
			"Error: file parameter required. Use `*` for workspace scope where supported.",
			false,
			params,
		);
	const resolvedFile = resolveToCwd(file, cwd);
	const serverInfo = getFirstServerForFile(config, resolvedFile);
	if (!serverInfo) return result(action, "No language server found for this action", false, params);
	const [serverName, serverConfig] = serverInfo;
	const client = await getOrCreateClient(serverConfig, cwd);
	await ensureFileOpen(client, resolvedFile, signal);
	if (PROJECT_INDEXED_ACTIONS.has(action) && isProjectAwareLspServer(serverConfig))
		await waitForProjectLoaded(client, signal);
	if (
		line !== undefined &&
		!symbol &&
		["references", "rename", "definition"].includes(action) &&
		isProjectAwareLspServer(serverConfig)
	) {
		throw new LspToolError(`symbol is required for project-aware ${action}; pass symbol=<name>, optionally symbol#N`);
	}
	const uri = fileToUri(resolvedFile);
	const position = { line: (line ?? 1) - 1, character: await resolveSymbolColumn(resolvedFile, line ?? 1, symbol) };
	let output: string;
	switch (action) {
		case "definition":
		case "type_definition":
		case "implementation": {
			const method =
				action === "definition"
					? "textDocument/definition"
					: action === "type_definition"
						? "textDocument/typeDefinition"
						: "textDocument/implementation";
			const found = normalizeLocationResult(
				(await sendRequest(client, method, { textDocument: { uri }, position }, signal)) as
					| Location
					| Location[]
					| LocationLink
					| LocationLink[]
					| null,
			);
			output =
				found.length === 0
					? `No ${action.replace("_", " ")} found`
					: `Found ${found.length} ${action.replace("_", " ")}(s):\n${(await Promise.all(found.map((location) => formatLocationWithContext(location, cwd)))).join("\n")}`;
			break;
		}
		case "references": {
			let found: Location[] | null = null;
			for (let attempt = 0; attempt <= REFERENCES_RETRY_COUNT; attempt++) {
				found = (await sendRequest(
					client,
					"textDocument/references",
					{ textDocument: { uri }, position, context: { includeDeclaration: true } },
					signal,
				)) as Location[] | null;
				if (
					!isProjectAwareLspServer(serverConfig) ||
					attempt === REFERENCES_RETRY_COUNT ||
					((found?.length ?? 0) > 0 && !isOnlyQueriedDeclaration(found ?? [], uri, position))
				)
					break;
				await waitForProjectLoaded(client, signal);
				await sleep(REFERENCES_RETRY_DELAY_MS, signal);
			}
			if (!found || found.length === 0) output = "No references found";
			else {
				const contextual = found.slice(0, REFERENCE_CONTEXT_LIMIT);
				const plain = found.slice(REFERENCE_CONTEXT_LIMIT).map((location) => `  ${formatLocation(location, cwd)}`);
				output = `Found ${found.length} reference(s):\n${[...(await Promise.all(contextual.map((location) => formatLocationWithContext(location, cwd)))), ...(plain.length ? [`  ... ${plain.length} additional reference(s) shown without context`, ...plain] : [])].join("\n")}`;
			}
			break;
		}
		case "hover": {
			const hover = (await sendRequest(
				client,
				"textDocument/hover",
				{ textDocument: { uri }, position },
				signal,
			)) as Hover | null;
			output = hover?.contents ? extractHoverText(hover.contents) : "No hover information";
			break;
		}
		case "symbols": {
			const symbols = (await sendRequest(
				client,
				"textDocument/documentSymbol",
				{ textDocument: { uri } },
				signal,
			)) as (DocumentSymbol | SymbolInformation)[] | null;
			if (!symbols || symbols.length === 0) output = "No symbols found";
			else if ("selectionRange" in symbols[0])
				output = `Symbols in ${formatPathRelativeToCwd(resolvedFile, cwd)}:\n${(symbols as DocumentSymbol[]).flatMap((item) => formatDocumentSymbol(item)).join("\n")}`;
			else
				output = `Symbols in ${formatPathRelativeToCwd(resolvedFile, cwd)}:\n${(symbols as SymbolInformation[]).map((item) => `${symbolKindToIcon(item.kind)} ${item.name} @ line ${item.location.range.start.line + 1}`).join("\n")}`;
			break;
		}
		case "code_actions": {
			const diagnostics = client.diagnostics.get(uri)?.diagnostics ?? [];
			const context: CodeActionContext = {
				diagnostics,
				only: !apply && query ? [query] : undefined,
				triggerKind: 1,
			};
			const actions = (await sendRequest(
				client,
				"textDocument/codeAction",
				{ textDocument: { uri }, range: { start: position, end: position }, context },
				signal,
			)) as (CodeAction | Command)[] | null;
			if (!actions || actions.length === 0) {
				output = "No code actions available";
				break;
			}
			if (apply === true && query) {
				const normalized = query.trim();
				const parsedIndex = /^\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : null;
				const selected = actions.find(
					(item, index) =>
						(parsedIndex !== null && index === parsedIndex) ||
						item.title.toLowerCase().includes(normalized.toLowerCase()),
				);
				if (!selected) {
					output = `No code action matches "${normalized}". Available actions:\n${actions.map((item, index) => `  ${formatCodeAction(item, index)}`).join("\n")}`;
					break;
				}
				const appliedAction = await applyCodeAction(selected, {
					resolveCodeAction: async (item) =>
						(await sendRequest(client, "codeAction/resolve", item, signal)) as CodeAction,
					applyWorkspaceEdit: async (edit) => applyWorkspaceEdit(edit, cwd),
					executeCommand: async (command) => {
						await sendRequest(
							client,
							"workspace/executeCommand",
							{ command: command.command, arguments: command.arguments ?? [] },
							signal,
						);
					},
				});
				output = appliedAction
					? `Applied "${appliedAction.title}":\n${[...appliedAction.edits.map((item) => `  ${item}`), ...appliedAction.executedCommands.map((item) => `  executed ${item}`)].join("\n")}`
					: `Action "${selected.title}" has no workspace edit or command to apply`;
			} else
				output = `${actions.length} code action(s):\n${actions.map((item, index) => `  ${formatCodeAction(item, index)}`).join("\n")}`;
			break;
		}
		case "rename": {
			if (!new_name)
				return result(action, "Error: new_name parameter required for rename", false, params, serverName);
			const edit = (await sendRequest(
				client,
				"textDocument/rename",
				{ textDocument: { uri }, position, newName: new_name },
				signal,
			)) as WorkspaceEdit | null;
			if (!edit) output = "Rename returned no edits";
			else if (apply === false)
				output = `Rename preview:\n${formatWorkspaceEdit(edit, cwd)
					.map((item) => `  ${item}`)
					.join("\n")}`;
			else
				output = `Applied rename:\n${(await applyWorkspaceEdit(edit, cwd)).map((item) => `  ${item}`).join("\n")}`;
			break;
		}
		case "reload": {
			await shutdownAll();
			configCache.delete(cwd);
			output = `Reloaded ${serverName}`;
			break;
		}
		default:
			output = `Unknown action: ${action}`;
	}
	return result(action, output, true, params, serverName);
}

async function handleWorkspaceSymbols(
	cwd: string,
	config: LspConfig,
	params: LspParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<LspToolDetails>> {
	const normalizedQuery = params.query?.trim();
	if (!normalizedQuery)
		return result(params.action, "Error: query parameter required for workspace symbol search", false, params);
	const aggregated: SymbolInformation[] = [];
	const responding = new Set<string>();
	for (const [serverName, serverConfig] of getLspServers(config)) {
		try {
			const client = await getOrCreateClient(serverConfig, cwd);
			const symbols = (await sendRequest(client, "workspace/symbol", { query: normalizedQuery }, signal)) as
				| SymbolInformation[]
				| null;
			if (symbols?.length) {
				responding.add(serverName);
				aggregated.push(...filterWorkspaceSymbols(symbols, normalizedQuery));
			}
		} catch (err) {
			if (isAbortLike(err, signal)) throw err;
		}
	}
	const deduped = dedupeWorkspaceSymbols(aggregated);
	if (deduped.length === 0)
		return result(
			params.action,
			`No symbols matching "${normalizedQuery}"`,
			true,
			params,
			Array.from(responding).join(", "),
		);
	const limited = deduped.slice(0, WORKSPACE_SYMBOL_LIMIT);
	const more =
		deduped.length > WORKSPACE_SYMBOL_LIMIT
			? `\n... ${deduped.length - WORKSPACE_SYMBOL_LIMIT} additional symbol(s) omitted`
			: "";
	return result(
		params.action,
		`Found ${deduped.length} symbol(s) matching "${normalizedQuery}":\n${limited.map((item) => `  ${formatSymbolInformation(item, cwd)}`).join("\n")}${more}`,
		true,
		params,
		Array.from(responding).join(", "),
	);
}

async function handleRawRequest(
	cwd: string,
	config: LspConfig,
	params: LspParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<LspToolDetails>> {
	const method = params.query?.trim();
	if (!method)
		return result(
			params.action,
			"Error: action=request requires `query` to specify the LSP method name",
			false,
			params,
		);
	const resolvedTarget = params.file && params.file !== "*" ? resolveToCwd(params.file, cwd) : null;
	const chosen = resolvedTarget ? getFirstServerForFile(config, resolvedTarget) : getLspServers(config)[0];
	if (!chosen)
		return result(
			params.action,
			resolvedTarget ? "No language server found for this file" : "No language servers configured",
			false,
			params,
		);
	const [serverName, serverConfig] = chosen;
	let requestParams: unknown;
	if (params.payload !== undefined) {
		try {
			requestParams = JSON.parse(params.payload);
		} catch (err) {
			return result(
				params.action,
				`Error: invalid JSON in payload: ${err instanceof Error ? err.message : String(err)}`,
				false,
				params,
				serverName,
			);
		}
	} else if (resolvedTarget) {
		const uri = fileToUri(resolvedTarget);
		requestParams =
			params.line !== undefined
				? {
						textDocument: { uri },
						position: {
							line: params.line - 1,
							character: await resolveSymbolColumn(resolvedTarget, params.line, params.symbol),
						},
					}
				: { textDocument: { uri } };
	} else requestParams = {};
	try {
		const client = await getOrCreateClient(serverConfig, cwd);
		if (resolvedTarget) await ensureFileOpen(client, resolvedTarget, signal);
		const response = await sendRequest(client, method, requestParams, signal);
		const formatted =
			response === null || response === undefined
				? "null"
				: typeof response === "string"
					? response
					: JSON.stringify(response, null, 2);
		return result(params.action, `${serverName} <- ${method}:\n${formatted}`, true, params, serverName);
	} catch (err) {
		const preview = JSON.stringify(requestParams ?? null);
		return result(
			params.action,
			`LSP error from ${serverName} on ${method}: ${err instanceof Error ? err.message : String(err)}\n  params: ${preview.length > 400 ? `${preview.slice(0, 397)}...` : preview}`,
			false,
			params,
			serverName,
		);
	}
}

export async function syncWrittenFile(
	cwd: string,
	filePath: string,
	content: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const config = getConfig(cwd);
	const resolved = resolveToCwd(filePath, cwd);
	const servers = getServersForFile(config, resolved);
	if (servers.length === 0) return undefined;
	for (const [, serverConfig] of servers) {
		const client = await getOrCreateClient(serverConfig, cwd);
		await syncContent(client, resolved, content, signal);
		await notifySaved(client, resolved, signal);
	}
	const diagnostics = await diagnosticsForFile(cwd, config, resolved, 5, signal);
	if (diagnostics.diagnostics.length === 0) return `LSP diagnostics for ${formatPathRelativeToCwd(resolved, cwd)}: OK`;
	return `LSP diagnostics for ${formatPathRelativeToCwd(resolved, cwd)}:\n${formatGroupedDiagnosticMessages(diagnostics.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic, formatPathRelativeToCwd(resolved, cwd))))}`;
}

export function isReadonlyLspAction(action: string): boolean {
	return READONLY_ACTIONS.has(action);
}
