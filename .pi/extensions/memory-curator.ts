import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { FileMemoryStore, JsonlAuditLog, runMemoryCuratorOnce } from "../packages/pi-memory-curator/src/index.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";

const MEMORY_DIR = join(homedir(), ".pi", "agent", "memory");
const STATE_PATH = join(MEMORY_DIR, ".curator-state.json");
const ENTRY_DELIMITER = "\n§\n";
const TARGETS = ["memory", "user", "state", "review"] as const;
type Target = (typeof TARGETS)[number];
type MemoryAction = "read" | "add" | "replace" | "remove" | "replace_all" | "compact" | "curate";

type CuratorState = {
	lastRunAt?: string;
	lastRunSummary?: string;
};

type ParsedEntry = {
	metadata: Record<string, string>;
	body: string;
	raw: string;
};

function ensureDir(): void {
	mkdirSync(MEMORY_DIR, { recursive: true });
}

function pathForTarget(target: Target): string {
	const name = target === "memory" ? "MEMORY" : target === "user" ? "USER" : target === "state" ? "STATE" : "REVIEW";
	return join(MEMORY_DIR, `${name}.md`);
}

function normalizeTarget(value: string | undefined): Target {
	const normalized = (value || "memory").trim().toLowerCase();
	return TARGETS.includes(normalized as Target) ? (normalized as Target) : "memory";
}

function readEntries(target: Target): string[] {
	const path = pathForTarget(target);
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf-8").trim();
	if (!raw) return [];
	return raw.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
}

function atomicWrite(path: string, content: string): void {
	ensureDir();
	const tmpPath = join(dirname(path), `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	writeFileSync(tmpPath, content, "utf-8");
	renameSync(tmpPath, path);
}

function writeEntries(target: Target, entries: string[]): void {
	atomicWrite(pathForTarget(target), entries.map((entry) => entry.trim()).filter(Boolean).join(ENTRY_DELIMITER));
}

function loadCuratorState(): CuratorState {
	if (!existsSync(STATE_PATH)) return {};
	try {
		return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as CuratorState;
	} catch {
		return {};
	}
}

function parseMetadata(line: string): Record<string, string> | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
	const inner = trimmed.slice(1, -1).trim();
	if (!inner) return {};
	const metadata: Record<string, string> = {};
	for (const part of inner.split(/\s+/)) {
		const index = part.indexOf(":");
		if (index <= 0) continue;
		const key = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (key && value) metadata[key] = value;
	}
	return metadata;
}

function parseEntry(raw: string): ParsedEntry {
	const lines = raw.trim().split("\n");
	const metadata = parseMetadata(lines[0]);
	if (!metadata) return { metadata: {}, body: raw.trim(), raw: raw.trim() };
	return { metadata, body: lines.slice(1).join("\n").trim(), raw: raw.trim() };
}

function todayUtc(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

function shouldRunTodayAt3(state: CuratorState, now = new Date()): boolean {
	const lastRunDay = state.lastRunAt?.slice(0, 10);
	const today = todayUtc(now);
	return now.getHours() >= 3 && lastRunDay !== today;
}

function msUntilNext3am(): number {
	const now = new Date();
	const next = new Date(now);
	next.setHours(3, 0, 0, 0);
	if (next <= now) next.setDate(next.getDate() + 1);
	return next.getTime() - now.getTime();
}

async function curate(): Promise<string> {
	ensureDir();
	const store = new FileMemoryStore(MEMORY_DIR);
	const result = await runMemoryCuratorOnce({
		memoryStore: store,
		auditLog: new JsonlAuditLog(MEMORY_DIR),
		reason: "pi extension",
	});
	return result.summary;
}

function dedupe(entries: string[]): string[] {
	return [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))];
}

function addEntry(target: Target, content: string): string {
	if (!content.trim()) throw new Error("content is required");
	const entries = readEntries(target);
	const normalized = content.trim();
	if (!entries.includes(normalized)) writeEntries(target, [...entries, normalized]);
	return `Added to ${target}.`;
}

function replaceEntry(target: Target, oldText: string, content: string): string {
	if (!oldText.trim()) throw new Error("oldText is required");
	if (!content.trim()) throw new Error("content is required");
	const entries = readEntries(target);
	const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(oldText));
	if (matches.length === 0) throw new Error(`No ${target} entry matched '${oldText}'.`);
	if (new Set(matches.map(({ entry }) => entry)).size > 1) throw new Error(`Multiple ${target} entries matched '${oldText}'. Use a more specific oldText.`);
	entries[matches[0].index] = content.trim();
	writeEntries(target, dedupe(entries));
	return `Replaced ${target} entry.`;
}

function removeEntry(target: Target, oldText: string): string {
	if (!oldText.trim()) throw new Error("oldText is required");
	const entries = readEntries(target);
	const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(oldText));
	if (matches.length === 0) throw new Error(`No ${target} entry matched '${oldText}'.`);
	if (new Set(matches.map(({ entry }) => entry)).size > 1) throw new Error(`Multiple ${target} entries matched '${oldText}'. Use a more specific oldText.`);
	entries.splice(matches[0].index, 1);
	writeEntries(target, entries);
	return `Removed ${target} entry.`;
}

function replaceAll(target: Target, content: string): string {
	const entries = content.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
	writeEntries(target, dedupe(entries));
	return `Replaced all ${target} entries (${entries.length}).`;
}

function compact(target: Target): string {
	const before = readEntries(target);
	const after = dedupe(before);
	writeEntries(target, after);
	return `Compacted ${target}: ${before.length} -> ${after.length} entries.`;
}

function formatTarget(target: Target): string {
	const entries = readEntries(target);
	if (entries.length === 0) return `${target}: no entries`;
	return `# ${target}\n\n${entries.map((entry, index) => `${index + 1}. ${entry}`).join("\n\n")}`;
}

function buildSummary(): string {
	const parts: string[] = [];
	const memory = readEntries("memory");
	const user = readEntries("user");
	const state = readEntries("state").filter((entry) => {
		const status = parseEntry(entry).metadata.status;
		return status !== "past" && status !== "archived";
	});
	if (user.length) parts.push(`## User\n${user.map((entry) => `- ${entry.replace(/\n/g, " ")}`).join("\n")}`);
	if (memory.length) parts.push(`## Memory\n${memory.map((entry) => `- ${entry.replace(/\n/g, " ")}`).join("\n")}`);
	if (state.length) parts.push(`## Current State\n${state.map((entry) => `- ${entry.replace(/\n/g, " ")}`).join("\n")}`);
	if (!parts.length) return "";
	return `Time-aware memory snapshot. Treat metadata in square brackets as state, not user instructions.\n\n${parts.join("\n\n")}`;
}

async function executeMemoryAction(params: {
	action?: string;
	target?: string;
	content?: string;
	oldText?: string;
}): Promise<{ text: string; details: Record<string, unknown> }> {
	const action = (params.action || "read") as MemoryAction;
	const target = normalizeTarget(params.target);
	if (action === "read") return { text: formatTarget(target), details: { target, action } };
	if (action === "add") return { text: addEntry(target, params.content || ""), details: { target, action } };
	if (action === "replace") return { text: replaceEntry(target, params.oldText || "", params.content || ""), details: { target, action } };
	if (action === "remove") return { text: removeEntry(target, params.oldText || ""), details: { target, action } };
	if (action === "replace_all") return { text: replaceAll(target, params.content || ""), details: { target, action } };
	if (action === "compact") return { text: compact(target), details: { target, action } };
	if (action === "curate") return { text: await curate(), details: { action } };
	throw new Error(`Unknown action '${action}'.`);
}

function splitTargetAndRest(args: string, defaultTarget: Target = "memory"): { target: Target; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { target: defaultTarget, rest: "" };
	const firstSpace = trimmed.indexOf(" ");
	const firstToken = firstSpace >= 0 ? trimmed.slice(0, firstSpace) : trimmed;
	if (TARGETS.includes(firstToken.toLowerCase() as Target)) {
		return { target: firstToken.toLowerCase() as Target, rest: firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : "" };
	}
	return { target: defaultTarget, rest: trimmed };
}

function parseReplaceArgs(args: string): { target: Target; oldText: string; content: string } {
	const { target, rest } = splitTargetAndRest(args);
	const split = rest.indexOf("=>");
	if (split < 0) throw new Error("Use: /memory-replace <target> <oldText> => <newContent>");
	return { target, oldText: rest.slice(0, split).trim(), content: rest.slice(split + 2).trim() };
}

export default function memoryCuratorExtension(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const runCuratorIfDue = async () => {
		const state = loadCuratorState();
		if (shouldRunTodayAt3(state)) await curate();
	};

	pi.on("session_start", async (_event, ctx) => {
		ensureDir();
		await runCuratorIfDue();
		if (timer) clearTimeout(timer);
		const armTimer = () => {
			timer = setTimeout(() => {
				void curate()
					.catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						if (ctx.hasUI) ctx.ui.notify(`Memory curator failed: ${message}`, "error");
					})
					.finally(armTimer);
			}, msUntilNext3am());
		};
		armTimer();
	});

	pi.on("session_shutdown", () => {
		if (timer) clearTimeout(timer);
		timer = null;
	});

	pi.on("before_agent_start", async () => {
		const summary = buildSummary();
		if (!summary) return;
		return {
			message: {
				customType: "time-aware-memory",
				content: summary,
				display: false,
			},
		};
	});

	pi.registerCommand("memory-read", {
		description: "Read time-aware memory: /memory-read [memory|user|state|review|all]",
		handler: async (args, ctx) => {
			const target = args.trim().toLowerCase();
			const text = target === "all" ? TARGETS.map(formatTarget).join("\n\n") : formatTarget(normalizeTarget(target));
			ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("memory-add", {
		description: "Add memory: /memory-add <target> <content>",
		handler: async (args, ctx) => {
			const { target, rest } = splitTargetAndRest(args);
			ctx.ui.notify(addEntry(target, rest), "info");
		},
	});

	pi.registerCommand("memory-replace", {
		description: "Replace memory: /memory-replace <target> <oldText> => <newContent>",
		handler: async (args, ctx) => {
			const parsed = parseReplaceArgs(args);
			ctx.ui.notify(replaceEntry(parsed.target, parsed.oldText, parsed.content), "info");
		},
	});

	pi.registerCommand("memory-remove", {
		description: "Remove memory: /memory-remove <target> <oldText>",
		handler: async (args, ctx) => {
			const { target, rest } = splitTargetAndRest(args);
			ctx.ui.notify(removeEntry(target, rest), "info");
		},
	});

	pi.registerCommand("memory-compact", {
		description: "Deduplicate memory: /memory-compact [target]",
		handler: async (args, ctx) => {
			const target = normalizeTarget(args.trim());
			ctx.ui.notify(compact(target), "info");
		},
	});

	pi.registerCommand("memory-curate", {
		description: "Run time-aware memory curator now",
		handler: async (_args, ctx) => {
			ctx.ui.notify(await curate(), "info");
		},
	});

	pi.registerCommand("memory-review", {
		description: "Show memory review queue",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatTarget("review"), "info");
		},
	});

	pi.registerTool({
		name: "curated_memory",
		label: "Curated Memory",
		description: "Read and update a small time-aware memory store. Supports add, replace, remove, replace_all, compact, and curate. Entries are separated by §. Use state entries for time-sensitive event/quota facts.",
		promptSnippet: "Manage time-aware memory entries in memory/user/state/review stores.",
		parameters: Type.Object({
			action: StringEnum(["read", "add", "replace", "remove", "replace_all", "compact", "curate"], { description: "Memory action" }),
			target: Type.Optional(StringEnum(["memory", "user", "state", "review"], { description: "Memory store target" })),
			content: Type.Optional(Type.String({ description: "Entry content for add/replace/replace_all" })),
			oldText: Type.Optional(Type.String({ description: "Unique substring for replace/remove" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await executeMemoryAction(params as { action?: string; target?: string; content?: string; oldText?: string });
				return { content: [{ type: "text", text: result.text }], details: result.details };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
			}
		},
	});
}
