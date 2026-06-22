import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import { applyWorkspaceEdit } from "./edits.ts";
import { LspToolError, throwIfAborted } from "./errors.ts";
import { fileToUri, formatPathRelativeToCwd, resolveToCwd, uriToFile } from "./path-utils.ts";
import type {
	CodeAction,
	Command,
	Diagnostic,
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	MarkedString,
	MarkupContent,
	Position,
	SymbolInformation,
	TextEdit,
	WorkspaceEdit,
} from "./types.ts";
import { SYMBOL_KIND_NAMES } from "./types.ts";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(new Error("Operation aborted"));
				},
				{ once: true },
			);
		}
	});
}

export function detectLanguageId(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	const base = path.basename(filePath);
	const map: Record<string, string> = {
		".ts": "typescript",
		".tsx": "typescriptreact",
		".js": "javascript",
		".jsx": "javascriptreact",
		".mjs": "javascript",
		".cjs": "javascript",
		".json": "json",
		".jsonc": "jsonc",
		".rs": "rust",
		".go": "go",
		".py": "python",
		".pyi": "python",
		".java": "java",
		".kt": "kotlin",
		".kts": "kotlin",
		".swift": "swift",
		".c": "c",
		".h": "c",
		".cpp": "cpp",
		".cc": "cpp",
		".cxx": "cpp",
		".hpp": "cpp",
		".cs": "csharp",
		".rb": "ruby",
		".php": "php",
		".lua": "lua",
		".sh": "shellscript",
		".bash": "shellscript",
		".zsh": "shellscript",
		".yaml": "yaml",
		".yml": "yaml",
		".html": "html",
		".css": "css",
		".scss": "scss",
		".sass": "sass",
		".less": "less",
		".vue": "vue",
		".svelte": "svelte",
		".astro": "astro",
		".md": "markdown",
		".markdown": "markdown",
		".xml": "xml",
		".toml": "toml",
		".tf": "terraform",
		".nix": "nix",
		".dart": "dart",
		".scala": "scala",
		".hs": "haskell",
		".ex": "elixir",
		".exs": "elixir",
		".erl": "erlang",
		".gleam": "gleam",
		".ml": "ocaml",
		".mli": "ocaml",
		".zig": "zig",
	};
	if (base === "Dockerfile") return "dockerfile";
	return map[ext] ?? (ext.replace(/^\./, "") || "plaintext");
}

export function extractHoverText(contents: Hover["contents"]): string {
	const renderMarked = (value: MarkupContent | MarkedString): string => {
		if (typeof value === "string") return value;
		if ("value" in value) return value.value;
		return JSON.stringify(value);
	};
	return Array.isArray(contents) ? contents.map(renderMarked).join("\n\n") : renderMarked(contents);
}

function severityLabel(severity: Diagnostic["severity"]): string {
	if (severity === 1) return "error";
	if (severity === 2) return "warning";
	if (severity === 3) return "info";
	if (severity === 4) return "hint";
	return "diagnostic";
}

export function sortDiagnostics(diagnostics: Diagnostic[]): void {
	diagnostics.sort(
		(a, b) =>
			a.range.start.line - b.range.start.line ||
			a.range.start.character - b.range.start.character ||
			severityLabel(a.severity).localeCompare(severityLabel(b.severity)),
	);
}

export function formatDiagnosticsSummary(diagnostics: Diagnostic[]): string {
	const counts = new Map<string, number>();
	for (const diagnostic of diagnostics) {
		const label = severityLabel(diagnostic.severity);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return Array.from(counts)
		.map(([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`)
		.join(", ");
}

export function formatDiagnostic(diagnostic: Diagnostic, relPath: string): string {
	const line = diagnostic.range.start.line + 1;
	const column = diagnostic.range.start.character + 1;
	const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
	const code = diagnostic.code !== undefined ? ` ${diagnostic.code}` : "";
	return `${relPath}:${line}:${column}: ${severityLabel(diagnostic.severity)}${source}${code}: ${diagnostic.message}`;
}

export function formatGroupedDiagnosticMessages(messages: string[]): string {
	return messages.map((message) => `  ${message}`).join("\n");
}

export function summarizeDiagnosticMessages(diagnostics: Diagnostic[]): string {
	if (diagnostics.length === 0) return "OK";
	return `${formatDiagnosticsSummary(diagnostics)}:\n${diagnostics.map((d) => `- ${d.message}`).join("\n")}`;
}

export function formatLocation(location: Location, cwd: string): string {
	const filePath = uriToFile(location.uri);
	return `${formatPathRelativeToCwd(filePath, cwd)}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
}

export async function readLocationContext(location: Location, cwd: string): Promise<string> {
	const filePath = uriToFile(location.uri);
	const rel = formatPathRelativeToCwd(filePath, cwd);
	try {
		const content = await fs.readFile(filePath, "utf8");
		const lines = content.split(/\r?\n/);
		const line = location.range.start.line;
		const start = Math.max(0, line - 1);
		const end = Math.min(lines.length, line + 2);
		const context = lines
			.slice(start, end)
			.map((text, index) => `${start + index + 1}: ${text}`)
			.join("\n");
		return `${rel}:${line + 1}:${location.range.start.character + 1}\n${context}`;
	} catch {
		return `${rel}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
	}
}

export function normalizeLocationResult(
	result: Location | Location[] | LocationLink | LocationLink[] | null,
): Location[] {
	if (!result) return [];
	const array = Array.isArray(result) ? result : [result];
	return array.map((item) => {
		if ("targetUri" in item) return { uri: item.targetUri, range: item.targetSelectionRange };
		return item;
	});
}

export async function formatLocationWithContext(location: Location, cwd: string): Promise<string> {
	return `  ${await readLocationContext(location, cwd)}`;
}

export function symbolKindToIcon(kind: number): string {
	return SYMBOL_KIND_NAMES[kind as keyof typeof SYMBOL_KIND_NAMES] ?? "Symbol";
}

export function formatDocumentSymbol(symbol: DocumentSymbol, depth = 0): string[] {
	const prefix = "  ".repeat(depth);
	const detail = symbol.detail ? ` ${symbol.detail}` : "";
	const line = `${prefix}${symbolKindToIcon(symbol.kind)} ${symbol.name}${detail} @ line ${symbol.selectionRange.start.line + 1}`;
	return [line, ...(symbol.children ?? []).flatMap((child) => formatDocumentSymbol(child, depth + 1))];
}

export function formatSymbolInformation(symbol: SymbolInformation, cwd: string): string {
	const container = symbol.containerName ? ` (${symbol.containerName})` : "";
	return `${symbolKindToIcon(symbol.kind)} ${symbol.name}${container} @ ${formatLocation(symbol.location, cwd)}`;
}

export function filterWorkspaceSymbols(symbols: SymbolInformation[], query: string): SymbolInformation[] {
	const normalized = query.toLowerCase();
	return symbols.filter((symbol) => symbol.name.toLowerCase().includes(normalized));
}

export function dedupeWorkspaceSymbols(symbols: SymbolInformation[]): SymbolInformation[] {
	const seen = new Set<string>();
	const out: SymbolInformation[] = [];
	for (const symbol of symbols) {
		const key = `${symbol.name}:${symbol.kind}:${symbol.location.uri}:${symbol.location.range.start.line}:${symbol.location.range.start.character}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(symbol);
	}
	return out;
}

export function formatCodeAction(action: CodeAction | Command, index: number): string {
	const kind = "kind" in action && action.kind ? ` [${action.kind}]` : "";
	const disabled = "disabled" in action && action.disabled ? ` (disabled: ${action.disabled.reason})` : "";
	return `${index}: ${action.title}${kind}${disabled}`;
}

function isCommandOnly(action: CodeAction | Command): action is Command {
	return typeof (action as Command).command === "string";
}

export async function applyCodeAction(
	action: CodeAction | Command,
	handlers: {
		resolveCodeAction: (action: CodeAction) => Promise<CodeAction>;
		applyWorkspaceEdit: (edit: WorkspaceEdit) => Promise<string[]>;
		executeCommand: (command: Command) => Promise<void>;
	},
): Promise<{ title: string; edits: string[]; executedCommands: string[] } | null> {
	if (isCommandOnly(action)) {
		await handlers.executeCommand(action);
		return { title: action.title, edits: [], executedCommands: [action.command] };
	}
	let resolved: CodeAction = action;
	if (!resolved.edit && resolved.data !== undefined) {
		resolved = await handlers.resolveCodeAction(resolved);
	}
	const edits = resolved.edit ? await handlers.applyWorkspaceEdit(resolved.edit) : [];
	const executedCommands: string[] = [];
	if (resolved.command) {
		await handlers.executeCommand(resolved.command);
		executedCommands.push(resolved.command.command);
	}
	return edits.length > 0 || executedCommands.length > 0 ? { title: resolved.title, edits, executedCommands } : null;
}

export async function resolveSymbolColumn(filePath: string, line: number, symbol?: string): Promise<number> {
	const content = await fs.readFile(filePath, "utf8");
	const lines = content.split(/\r?\n/);
	const text = lines[line - 1];
	if (text === undefined) throw new LspToolError(`line ${line} is out of range`);
	if (!symbol) {
		const match = text.match(/\S/);
		return match?.index ?? 0;
	}
	const occurrenceMatch = symbol.match(/^(.*)#(\d+)$/);
	const needle = occurrenceMatch ? occurrenceMatch[1] : symbol;
	const occurrence = occurrenceMatch ? Number.parseInt(occurrenceMatch[2], 10) : 1;
	let from = 0;
	for (let i = 1; i <= occurrence; i++) {
		const index = text.indexOf(needle, from);
		if (index === -1)
			throw new LspToolError(`symbol ${JSON.stringify(needle)} occurrence #${occurrence} not found on line ${line}`);
		if (i === occurrence) return index;
		from = index + needle.length;
	}
	return 0;
}

export async function resolveDiagnosticTargets(
	pattern: string,
	cwd: string,
	max: number,
): Promise<{ matches: string[]; truncated: boolean }> {
	if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("[")) {
		return { matches: [resolveToCwd(pattern, cwd)], truncated: false };
	}
	const matches = await glob(pattern, {
		cwd,
		nodir: true,
		dot: true,
		absolute: true,
		ignore: ["**/node_modules/**", "**/.git/**"],
	});
	return { matches: matches.slice(0, max), truncated: matches.length > max };
}

export function isOnlyQueriedDeclaration(locations: Location[], uri: string, position: Position): boolean {
	return locations.length === 1 && locations[0].uri === uri && locations[0].range.start.line === position.line;
}

export async function enumerateRenamePairs(
	source: string,
	dest: string,
	max: number,
): Promise<{ pairs: Array<{ oldUri: string; newUri: string }>; exceeded: boolean }> {
	const stat = await fs.stat(source);
	if (!stat.isDirectory()) return { pairs: [{ oldUri: fileToUri(source), newUri: fileToUri(dest) }], exceeded: false };
	const pairs: Array<{ oldUri: string; newUri: string }> = [];
	async function walk(current: string): Promise<void> {
		if (pairs.length > max) return;
		const entries = await fs.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) await walk(entryPath);
			else if (entry.isFile()) {
				const rel = path.relative(source, entryPath);
				pairs.push({ oldUri: fileToUri(entryPath), newUri: fileToUri(path.join(dest, rel)) });
				if (pairs.length > max) return;
			}
		}
	}
	await walk(source);
	return { pairs: pairs.slice(0, max), exceeded: pairs.length > max };
}

export async function runWorkspaceDiagnostics(
	cwd: string,
	runFileDiagnostics: (file: string) => Promise<Diagnostic[]>,
): Promise<string> {
	const files = await glob("**/*", {
		cwd,
		nodir: true,
		absolute: true,
		ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
	});
	const outputs: string[] = [];
	for (const file of files.slice(0, 200)) {
		const diagnostics = await runFileDiagnostics(file);
		if (diagnostics.length === 0) continue;
		const rel = formatPathRelativeToCwd(file, cwd);
		outputs.push(`${rel}: ${formatDiagnosticsSummary(diagnostics)}`);
		outputs.push(formatGroupedDiagnosticMessages(diagnostics.map((d) => formatDiagnostic(d, rel))));
	}
	return outputs.length > 0 ? outputs.join("\n") : "OK";
}

export { applyWorkspaceEdit, fileToUri, formatPathRelativeToCwd, resolveToCwd, throwIfAborted, uriToFile };
export type { TextEdit, WorkspaceEdit };
