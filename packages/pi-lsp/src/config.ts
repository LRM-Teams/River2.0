import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globSync } from "glob";
import YAML from "yaml";
import { DEFAULT_SERVERS } from "./defaults.ts";
import type { ServerConfig } from "./types.ts";

export interface LspConfig {
	servers: Record<string, ServerConfig>;
	idleTimeoutMs?: number;
}

interface ParsedConfig {
	servers: Record<string, Partial<ServerConfig> | false | null>;
	idleTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function coerceServerConfig(name: string, value: unknown): Partial<ServerConfig> | false | null {
	if (value === false || value === null) return value;
	if (!isRecord(value)) return null;
	const config: Partial<ServerConfig> = {};
	if (typeof value.command === "string") config.command = value.command;
	if (isStringArray(value.args)) config.args = value.args;
	if (isStringArray(value.fileTypes)) config.fileTypes = value.fileTypes;
	if (isStringArray(value.rootMarkers)) config.rootMarkers = value.rootMarkers;
	if (isRecord(value.initOptions)) config.initOptions = value.initOptions;
	if (isRecord(value.settings)) config.settings = value.settings;
	if (typeof value.disabled === "boolean") config.disabled = value.disabled;
	if (typeof value.warmupTimeoutMs === "number") config.warmupTimeoutMs = value.warmupTimeoutMs;
	if (isRecord(value.capabilities)) config.capabilities = value.capabilities;
	if (typeof value.isLinter === "boolean") config.isLinter = value.isLinter;
	if (!config.command && !DEFAULT_SERVERS[name]) return null;
	return config;
}

function parseConfigFile(filePath: string): ParsedConfig | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		const text = fs.readFileSync(filePath, "utf8");
		const parsed = filePath.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
		if (!isRecord(parsed)) return null;
		const servers: Record<string, Partial<ServerConfig> | false | null> = {};
		if (isRecord(parsed.servers)) {
			for (const [name, raw] of Object.entries(parsed.servers)) {
				servers[name] = coerceServerConfig(name, raw);
			}
		}
		return {
			servers,
			idleTimeoutMs: typeof parsed.idleTimeoutMs === "number" ? parsed.idleTimeoutMs : undefined,
		};
	} catch (err) {
		console.warn(`[pi-lsp] ignoring invalid config ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

function filenames(): string[] {
	return ["lsp.json", ".lsp.json", "lsp.yaml", ".lsp.yaml", "lsp.yml", ".lsp.yml"];
}

function configSources(cwd: string): string[] {
	const sources: string[] = [];
	for (const filename of filenames()) sources.push(path.join(cwd, filename));
	for (const dir of [".pi", ".omp", ".claude"]) {
		for (const filename of filenames()) sources.push(path.join(cwd, dir, filename));
	}
	for (const dir of [".pi/agent", ".omp/agent", ".claude"]) {
		for (const filename of filenames()) sources.push(path.join(os.homedir(), dir, filename));
	}
	for (const filename of filenames()) sources.push(path.join(os.homedir(), filename));
	return sources;
}

function mergeServers(
	base: Record<string, ServerConfig>,
	overrides: Record<string, Partial<ServerConfig> | false | null>,
): Record<string, ServerConfig> {
	const next: Record<string, ServerConfig> = { ...base };
	for (const [name, override] of Object.entries(overrides)) {
		if (override === false || override === null || override.disabled === true) {
			delete next[name];
			continue;
		}
		const existing = next[name];
		if (!existing && (!override.command || !override.fileTypes || !override.rootMarkers)) continue;
		next[name] = {
			command: override.command ?? existing.command,
			args: override.args ?? existing.args,
			fileTypes: override.fileTypes ?? existing.fileTypes,
			rootMarkers: override.rootMarkers ?? existing.rootMarkers,
			initOptions: override.initOptions ?? existing.initOptions,
			settings: override.settings ?? existing.settings,
			disabled: override.disabled ?? existing.disabled,
			warmupTimeoutMs: override.warmupTimeoutMs ?? existing.warmupTimeoutMs,
			workspaceReadyTimings: override.workspaceReadyTimings ?? existing.workspaceReadyTimings,
			capabilities: override.capabilities ?? existing.capabilities,
			isLinter: override.isLinter ?? existing.isLinter,
		};
	}
	return next;
}

function commandCandidates(command: string, cwd: string): string[] {
	if (path.isAbsolute(command) || command.includes(path.sep)) return [path.resolve(cwd, command)];
	const candidates: string[] = [path.join(cwd, "node_modules", ".bin", command)];
	const pathValue = process.env.PATH ?? "";
	for (const entry of pathValue.split(path.delimiter)) {
		if (entry) candidates.push(path.join(entry, command));
	}
	if (process.platform === "win32") {
		return candidates.flatMap((candidate) => [candidate, `${candidate}.cmd`, `${candidate}.exe`, `${candidate}.bat`]);
	}
	return candidates;
}

function resolveCommand(command: string, cwd: string): string | undefined {
	for (const candidate of commandCandidates(command, cwd)) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

function markerExists(cwd: string, marker: string): boolean {
	if (marker.includes("*")) {
		return globSync(marker, { cwd, dot: true, nodir: false, maxDepth: 4 }).length > 0;
	}
	return fs.existsSync(path.join(cwd, marker));
}

function hasRootMarkers(cwd: string, markers: string[]): boolean {
	return markers.length === 0 || markers.some((marker) => markerExists(cwd, marker));
}

export function loadConfig(cwd: string): LspConfig {
	let servers: Record<string, ServerConfig> = { ...DEFAULT_SERVERS };
	let hasOverrides = false;
	let idleTimeoutMs: number | undefined;
	for (const source of configSources(cwd).reverse()) {
		const parsed = parseConfigFile(source);
		if (!parsed) continue;
		if (Object.keys(parsed.servers).length > 0) {
			hasOverrides = true;
			servers = mergeServers(servers, parsed.servers);
		}
		if (parsed.idleTimeoutMs !== undefined) idleTimeoutMs = parsed.idleTimeoutMs;
	}

	const available: Record<string, ServerConfig> = {};
	for (const [name, config] of Object.entries(servers)) {
		if (config.disabled) continue;
		if (!hasRootMarkers(cwd, config.rootMarkers)) continue;
		const resolvedCommand = resolveCommand(config.command, cwd);
		if (!resolvedCommand) continue;
		available[name] = { ...config, resolvedCommand };
	}

	return { servers: hasOverrides ? available : available, idleTimeoutMs };
}

export function getServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	const ext = path.extname(filePath).toLowerCase();
	const base = path.basename(filePath);
	return Object.entries(config.servers).filter(([, server]) =>
		server.fileTypes.some((fileType) => fileType.toLowerCase() === ext || fileType === base),
	);
}

export function getFirstServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	return getServersForFile(config, filePath)[0] ?? null;
}

export function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
	return Object.entries(config.servers);
}
