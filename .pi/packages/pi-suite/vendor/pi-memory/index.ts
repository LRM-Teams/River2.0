/**
 * Memory Extension with QMD-Powered Search
 *
 * Structured Markdown memory system with semantic search via qmd.
 * Core memory tools (write/read/edit/scratchpad) work without qmd installed.
 * The memory_search tool requires qmd for keyword, semantic, and hybrid search.
 *
 * Layout (under ~/.pi/agent/memory/):
 *   MEMORY.md             — durable facts, decisions, and preferences
 *   USER.md               — structured user profile and stable preferences
 *   STATE.md              — current dated state, events, temporary facts, quotas
 *   REVIEW.md             — review queue for stale or merge-candidate memories
 *   SCRATCHPAD.md         — checklist of things to keep in mind / fix later
 *   daily/YYYY-MM-DD.md   — daily append-only log (today + yesterday loaded at session start)
 *
 * Tools:
 *   memory_write   — write to long-term, daily, user, state, or review memory
 *   memory_read    — read any memory target or list daily logs
 *   memory_edit    — add, replace, remove, replace_all, or compact structured entries
 *   scratchpad     — add/check/uncheck/clear items on the scratchpad checklist
 *   memory_search  — search across all memory files via qmd (keyword, semantic, or deep)
 *   memory_curate  — run curator lifecycle rules immediately
 *
 * Context injection:
 *   - SCRATCHPAD.md + daily logs + USER.md + current STATE.md + MEMORY.md
 */

import { type ExecFileOptions, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { complete, type Message, StringEnum } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { JsonlAuditLog } from "./src/curator-core/audit.ts";
import { parseEntry as parseStructuredEntry, parseMetadata as parseStructuredMetadata, serializeMetadata } from "./src/curator-core/metadata.ts";
import { runMemoryCuratorOnce } from "./src/curator-core/curate.ts";
import {
	REVIEW_CANDIDATE_KINDS,
	REVIEW_CONFIDENCES,
	REVIEW_TARGET_HINTS,
	upsertReviewCandidate,
	type ReviewCandidateInput,
} from "./src/learning/candidates.ts";
import { applyReviewLifecycle, approveMemoryPromotion, proposeMemoryPromotions, rejectReviewItem } from "./src/learning/memory.ts";
import { approveSkillDraft, listSkillDraftProposals, proposeSkillDrafts } from "./src/learning/skills.ts";
import { FileMemoryStore } from "./src/curator-store/file-store.ts";
import { disableCuratorService, enableCuratorService, getCuratorServiceStatus } from "./src/service-controller.ts";


// ---------------------------------------------------------------------------
// Paths (mutable for testing via _setBaseDir / _resetBaseDir)
// ---------------------------------------------------------------------------

type MemoryEnv = Partial<
	Record<"PI_MEMORY_DIR" | "HOME" | "USERPROFILE" | "HOMEDRIVE" | "HOMEPATH", string | undefined>
> & {
	[key: string]: string | undefined;
};

export function resolveMemoryDir(env: MemoryEnv = process.env): string {
	if (env.PI_MEMORY_DIR) return env.PI_MEMORY_DIR;
	const home =
		env.HOME ??
		env.USERPROFILE ??
		(env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined) ??
		"~";
	return path.join(home, ".pi", "agent", "memory");
}

let MEMORY_DIR = resolveMemoryDir();
let MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
let USER_FILE = path.join(MEMORY_DIR, "USER.md");
let STATE_FILE = path.join(MEMORY_DIR, "STATE.md");
let REVIEW_FILE = path.join(MEMORY_DIR, "REVIEW.md");
let SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
let DAILY_DIR = path.join(MEMORY_DIR, "daily");
let SKILL_DRAFTS_DIR = path.join(path.dirname(MEMORY_DIR), "skill-drafts");

/** Override base directory (for testing). */
export function _setBaseDir(baseDir: string) {
	MEMORY_DIR = baseDir;
	MEMORY_FILE = path.join(baseDir, "MEMORY.md");
	USER_FILE = path.join(baseDir, "USER.md");
	STATE_FILE = path.join(baseDir, "STATE.md");
	REVIEW_FILE = path.join(baseDir, "REVIEW.md");
	SCRATCHPAD_FILE = path.join(baseDir, "SCRATCHPAD.md");
	DAILY_DIR = path.join(baseDir, "daily");
	SKILL_DRAFTS_DIR = path.join(path.dirname(baseDir), "skill-drafts");
}

/** Reset to default paths (for testing). */
export function _resetBaseDir() {
	_setBaseDir(resolveMemoryDir());
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function ensureDirs() {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.mkdirSync(DAILY_DIR, { recursive: true });
}

export function todayStr(): string {
	const d = new Date();
	return d.toISOString().slice(0, 10);
}

export function yesterdayStr(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return d.toISOString().slice(0, 10);
}

export function nowTimestamp(): string {
	return new Date()
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

export function shortSessionId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

export function readFileSafe(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

const DAILY_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDailyDate(date: string): boolean {
	if (!DAILY_DATE_REGEX.test(date)) return false;
	const [year, month, day] = date.split("-").map(Number);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function dailyPath(date: string): string {
	if (!isValidDailyDate(date)) {
		throw new Error(`Invalid daily date: ${date}. Expected YYYY-MM-DD.`);
	}
	return path.join(DAILY_DIR, `${date}.md`);
}


function structuredMemoryPath(target: StructuredMemoryTarget): string {
	if (target === "memory") return MEMORY_FILE;
	if (target === "user") return USER_FILE;
	if (target === "state") return STATE_FILE;
	return REVIEW_FILE;
}

function normalizeStructuredMemoryTarget(value: string | undefined, fallback: StructuredMemoryTarget = "memory"): StructuredMemoryTarget {
	const normalized = (value || fallback).trim().toLowerCase();
	return STRUCTURED_MEMORY_TARGETS.includes(normalized as StructuredMemoryTarget) ? (normalized as StructuredMemoryTarget) : fallback;
}

function readStructuredEntries(target: StructuredMemoryTarget): string[] {
	const content = readFileSafe(structuredMemoryPath(target))?.trim();
	if (!content) return [];
	return content.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
}

function writeStructuredEntries(target: StructuredMemoryTarget, entries: string[]): void {
	ensureDirs();
	const content = entries.map((entry) => entry.trim()).filter(Boolean).join(ENTRY_DELIMITER);
	fs.writeFileSync(structuredMemoryPath(target), content, "utf-8");
}

function dedupeEntries(entries: string[]): string[] {
	return [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))];
}

function sanitizeMetadataValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed.replace(/[\s\]]+/g, "-");
}

function buildStructuredEntry(options: StructuredWriteOptions): string {
	const content = options.content.trim();
	if (!content) throw new Error("content is required");
	const firstLine = content.split("\n")[0] || "";
	const hasExplicitMetadata = parseStructuredMetadata(firstLine) !== undefined;
	const hasMetadataArgs = Boolean(
		options.type || options.status || options.date || options.reset || options.month || options.provider || options.used || options.limit || options.ttlDays,
	);
	if (hasExplicitMetadata && !hasMetadataArgs) return content;

	const type = sanitizeMetadataValue(options.type) || (options.target === "review" ? "review" : "fact");
	if ((type === "event" || type === "temporary") && !options.date) throw new Error(`${type} memory requires date.`);
	if (type === "quota" && !options.provider) throw new Error("quota memory requires provider.");

	const metadata: Record<string, string> = { type };
	const status = sanitizeMetadataValue(options.status) || (type === "event" ? "planned" : type === "temporary" || type === "quota" ? "active" : undefined);
	if (status) metadata.status = status;
	const fields = {
		date: sanitizeMetadataValue(options.date),
		reset: sanitizeMetadataValue(options.reset),
		month: sanitizeMetadataValue(options.month),
		provider: sanitizeMetadataValue(options.provider),
		used: sanitizeMetadataValue(options.used),
		limit: sanitizeMetadataValue(options.limit),
		ttlDays: sanitizeMetadataValue(options.ttlDays),
	};
	for (const [key, value] of Object.entries(fields)) {
		if (value) metadata[key] = value;
	}
	return `${serializeMetadata(metadata)}\n${content}`;
}

function addStructuredEntry(target: StructuredMemoryTarget, entry: string): boolean {
	const entries = readStructuredEntries(target);
	const normalized = entry.trim();
	if (entries.includes(normalized)) return false;
	writeStructuredEntries(target, [...entries, normalized]);
	return true;
}

function replaceStructuredEntry(target: StructuredMemoryTarget, oldText: string, content: string): string {
	if (!oldText.trim()) throw new Error("oldText is required");
	if (!content.trim()) throw new Error("content is required");
	const entries = readStructuredEntries(target);
	const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(oldText));
	if (matches.length === 0) throw new Error(`No ${target} entry matched '${oldText}'.`);
	if (new Set(matches.map(({ entry }) => entry)).size > 1) throw new Error(`Multiple ${target} entries matched '${oldText}'. Use a more specific oldText.`);
	entries[matches[0].index] = content.trim();
	writeStructuredEntries(target, dedupeEntries(entries));
	return `Replaced ${target} entry.`;
}

function removeStructuredEntry(target: StructuredMemoryTarget, oldText: string): string {
	if (!oldText.trim()) throw new Error("oldText is required");
	const entries = readStructuredEntries(target);
	const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(oldText));
	if (matches.length === 0) throw new Error(`No ${target} entry matched '${oldText}'.`);
	if (new Set(matches.map(({ entry }) => entry)).size > 1) throw new Error(`Multiple ${target} entries matched '${oldText}'. Use a more specific oldText.`);
	entries.splice(matches[0].index, 1);
	writeStructuredEntries(target, entries);
	return `Removed ${target} entry.`;
}

function replaceAllStructuredEntries(target: StructuredMemoryTarget, content: string): string {
	const entries = content.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
	writeStructuredEntries(target, dedupeEntries(entries));
	return `Replaced all ${target} entries (${entries.length}).`;
}

function compactStructuredEntries(target: StructuredMemoryTarget): string {
	const before = readStructuredEntries(target);
	const after = dedupeEntries(before);
	writeStructuredEntries(target, after);
	return `Compacted ${target}: ${before.length} -> ${after.length} entries.`;
}

function formatStructuredEntries(target: StructuredMemoryTarget): string {
	const entries = readStructuredEntries(target);
	if (entries.length === 0) return `${target}: no entries`;
	return `# ${target}\n\n${entries.map((entry, index) => `${index + 1}. ${entry}`).join("\n\n")}`;
}

function isCurrentStructuredState(entry: string): boolean {
	const status = parseStructuredEntry(entry).metadata.status;
	return status !== "past" && status !== "archived";
}

// ---------------------------------------------------------------------------
// Limits + preview helpers
// ---------------------------------------------------------------------------

const RESPONSE_PREVIEW_MAX_CHARS = 4_000;
const RESPONSE_PREVIEW_MAX_LINES = 120;

const CONTEXT_LONG_TERM_MAX_CHARS = 4_000;
const CONTEXT_LONG_TERM_MAX_LINES = 150;
const CONTEXT_SCRATCHPAD_MAX_CHARS = 2_000;
const CONTEXT_SCRATCHPAD_MAX_LINES = 120;
const CONTEXT_DAILY_MAX_CHARS = 3_000;
const CONTEXT_DAILY_MAX_LINES = 120;
const CONTEXT_SEARCH_MAX_CHARS = 2_500;
const CONTEXT_SEARCH_MAX_LINES = 80;
const CONTEXT_MAX_CHARS = 16_000;

const EXIT_SUMMARY_MAX_CHARS = 80_000;
const EXIT_SUMMARY_SYSTEM_PROMPT = [
	"You are a session recap assistant.",
	"Read the conversation and extract key decisions, lessons learned, notes, and follow-ups.",
	"Return ONLY markdown in the specified format, without any extra commentary.",
].join("\n");

const LEARNING_EXTRACTOR_MAX_CHARS = 60_000;
const LEARNING_EXTRACTOR_SYSTEM_PROMPT = [
	"You extract conservative memory-learning review candidates.",
	"Return ONLY JSON. Do not include markdown fences or commentary.",
	"Write candidates for durable preferences, project facts, verified bug fixes, or reusable skill-worthy methods only.",
	"Do not include workflow or loop artifacts.",
].join("\n");

const ENTRY_DELIMITER = "\n§\n";
const STRUCTURED_MEMORY_TARGETS = ["memory", "user", "state", "review"] as const;
const MEMORY_WRITE_TARGETS = ["long_term", "daily", "state", "user", "review"] as const;
const MEMORY_READ_TARGETS = ["long_term", "scratchpad", "daily", "list", "user", "state", "review", "all"] as const;
const MEMORY_EDIT_ACTIONS = ["read", "add", "replace", "remove", "replace_all", "compact"] as const;
const STRUCTURED_MEMORY_TYPES = ["fact", "preference", "event", "temporary", "quota", "review"] as const;

type StructuredMemoryTarget = (typeof STRUCTURED_MEMORY_TARGETS)[number];
type MemoryWriteTarget = (typeof MEMORY_WRITE_TARGETS)[number];
type MemoryReadTarget = (typeof MEMORY_READ_TARGETS)[number];
type MemoryEditAction = (typeof MEMORY_EDIT_ACTIONS)[number];

type StructuredWriteOptions = {
	target: StructuredMemoryTarget;
	content: string;
	type?: string;
	status?: string;
	date?: string;
	reset?: string;
	month?: string;
	provider?: string;
	used?: string;
	limit?: string;
	ttlDays?: string;
};

type TruncateMode = "start" | "end" | "middle";

interface PreviewResult {
	preview: string;
	truncated: boolean;
	totalLines: number;
	totalChars: number;
	previewLines: number;
	previewChars: number;
}

function normalizeContent(content: string): string {
	return content.trim();
}

function truncateLines(lines: string[], maxLines: number, mode: TruncateMode) {
	if (maxLines <= 0 || lines.length <= maxLines) {
		return { lines, truncated: false };
	}

	if (mode === "end") {
		return { lines: lines.slice(-maxLines), truncated: true };
	}

	if (mode === "middle" && maxLines > 1) {
		const marker = "... (truncated) ...";
		const keep = maxLines - 1;
		const headCount = Math.ceil(keep / 2);
		const tailCount = Math.floor(keep / 2);
		const head = lines.slice(0, headCount);
		const tail = tailCount > 0 ? lines.slice(-tailCount) : [];
		return { lines: [...head, marker, ...tail], truncated: true };
	}

	return { lines: lines.slice(0, maxLines), truncated: true };
}

function truncateText(text: string, maxChars: number, mode: TruncateMode) {
	if (maxChars <= 0 || text.length <= maxChars) {
		return { text, truncated: false };
	}

	if (mode === "end") {
		return { text: text.slice(-maxChars), truncated: true };
	}

	if (mode === "middle" && maxChars > 10) {
		const marker = "... (truncated) ...";
		const keep = maxChars - marker.length;
		if (keep > 0) {
			const headCount = Math.ceil(keep / 2);
			const tailCount = Math.floor(keep / 2);
			return {
				text: text.slice(0, headCount) + marker + text.slice(text.length - tailCount),
				truncated: true,
			};
		}
	}

	return { text: text.slice(0, maxChars), truncated: true };
}

function buildPreview(
	content: string,
	options: { maxLines: number; maxChars: number; mode: TruncateMode },
): PreviewResult {
	const normalized = normalizeContent(content);
	if (!normalized) {
		return {
			preview: "",
			truncated: false,
			totalLines: 0,
			totalChars: 0,
			previewLines: 0,
			previewChars: 0,
		};
	}

	const lines = normalized.split("\n");
	const totalLines = lines.length;
	const totalChars = normalized.length;

	const lineResult = truncateLines(lines, options.maxLines, options.mode);
	const text = lineResult.lines.join("\n");
	const charResult = truncateText(text, options.maxChars, options.mode);
	const preview = charResult.text;

	const previewLines = preview ? preview.split("\n").length : 0;
	const previewChars = preview.length;

	return {
		preview,
		truncated: lineResult.truncated || charResult.truncated,
		totalLines,
		totalChars,
		previewLines,
		previewChars,
	};
}

function formatPreviewBlock(label: string, content: string, mode: TruncateMode) {
	const result = buildPreview(content, {
		maxLines: RESPONSE_PREVIEW_MAX_LINES,
		maxChars: RESPONSE_PREVIEW_MAX_CHARS,
		mode,
	});

	if (!result.preview) {
		return `${label}: empty.`;
	}

	const meta = `${label} (${result.totalLines} lines, ${result.totalChars} chars)`;
	const note = result.truncated
		? `\n[preview truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars]`
		: "";
	return `${meta}\n\n${result.preview}${note}`;
}

function formatContextSection(label: string, content: string, mode: TruncateMode, maxLines: number, maxChars: number) {
	const result = buildPreview(content, { maxLines, maxChars, mode });
	if (!result.preview) {
		return "";
	}
	const note = result.truncated
		? `\n\n[truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars]`
		: "";
	return `${label}\n\n${result.preview}${note}`;
}

type ExitSummaryReason = "ctrl+d" | "slash-quit" | "session-end";
type TransitionHandoffReason = "new" | "fork";

interface ExitSummaryResult {
	summary: string | null;
	error?: string;
	hasMessages: boolean;
}

function formatExitSummaryReason(reason: ExitSummaryReason): string {
	if (reason === "ctrl+d") return "ctrl+d";
	if (reason === "slash-quit") return "/quit";
	return "session-end";
}

function truncateConversationForSummary(conversationText: string): {
	text: string;
	truncated: boolean;
	totalChars: number;
} {
	const trimmed = conversationText.trim();
	if (!trimmed) {
		return { text: "", truncated: false, totalChars: 0 };
	}
	const truncated = truncateText(trimmed, EXIT_SUMMARY_MAX_CHARS, "end");
	return {
		text: truncated.text,
		truncated: truncated.truncated,
		totalChars: trimmed.length,
	};
}

function buildExitSummaryPrompt(conversationText: string, truncated: boolean, totalChars: number): string {
	const lines = [
		"Review the conversation and extract important decisions, lessons learned, notes, and follow-ups for a daily log.",
		"Return markdown only with these exact headings:",
		"### Decisions",
		"### Lessons Learned",
		"### Notes",
		"### Follow-ups",
		'Use bullet points under each heading. If there is nothing, write "None.".',
	];

	if (truncated) {
		lines.push(
			`Note: Conversation transcript was truncated to the most recent ${conversationText.length} of ${totalChars} characters.`,
		);
	}

	lines.push("", "<conversation>", conversationText, "</conversation>");
	return lines.join("\n");
}

export function getMemoryLearningMode(env: MemoryEnv = process.env): "off" | "review" | "auto-review" {
	const value = (env.PI_MEMORY_LEARNING || "review").toLowerCase();
	return value === "off" || value === "auto-review" ? value : "review";
}

export function getMemorySkillDraftsMode(env: MemoryEnv = process.env): "off" | "review" {
	return env.PI_MEMORY_SKILL_DRAFTS?.toLowerCase() === "off" ? "off" : "review";
}

function getMemoryLearningMinConfidence(env: MemoryEnv = process.env): "low" | "medium" | "high" {
	const value = (env.PI_MEMORY_LEARNING_MIN_CONFIDENCE || "medium").toLowerCase();
	return value === "low" || value === "high" ? value : "medium";
}

function getMemoryAutoApproveMemory(env: MemoryEnv = process.env): boolean {
	return ["1", "true", "yes", "on"].includes((env.PI_MEMORY_AUTO_APPROVE_MEMORY || "").toLowerCase());
}

function getMemoryAutoApproveSkillDrafts(env: MemoryEnv = process.env): boolean {
	return ["1", "true", "yes", "on"].includes((env.PI_MEMORY_AUTO_APPROVE_SKILL_DRAFTS || "").toLowerCase());
}

function confidenceRank(confidence: "low" | "medium" | "high"): number {
	return confidence === "low" ? 0 : confidence === "medium" ? 1 : 2;
}

function shouldKeepLearningCandidate(confidence: "low" | "medium" | "high", env: MemoryEnv = process.env): boolean {
	return confidenceRank(confidence) >= confidenceRank(getMemoryLearningMinConfidence(env));
}

function buildLearningExtractorPrompt(conversationText: string, truncated: boolean, totalChars: number): string {
	const lines = [
		"Extract zero or more review candidates from this session transcript.",
		"Return JSON exactly shaped as: {\"candidates\":[{\"kind\":\"bug_fix|skill_candidate|preference|project_fact\",\"confidence\":\"low|medium|high\",\"signature\":\"short stable signature\",\"summary\":\"optional concise summary\",\"targetHints\":[\"memory\",\"skill\"],\"evidence\":\"optional compact evidence\"}]}",
		"Only include verified bug fixes when a failure was followed by an edit/action and successful validation.",
		"Drop one-off trivia, transient status, workflow artifacts, and loop artifacts.",
	];
	if (truncated) lines.push(`Transcript was truncated to the most recent ${conversationText.length} of ${totalChars} characters.`);
	lines.push("", "<conversation>", conversationText, "</conversation>");
	return lines.join("\n");
}

function buildExitSummaryFallback(error?: string): string {
	const note = error ? `- Auto-summary unavailable: ${error}.` : "- Auto-summary unavailable.";
	return [
		"### Decisions",
		"- None.",
		"### Lessons Learned",
		"- None.",
		"### Notes",
		note,
		"### Follow-ups",
		"- None.",
	].join("\n");
}

function formatExitSummaryEntry(
	summary: string,
	reason: ExitSummaryReason,
	sessionId: string,
	timestamp: string,
): string {
	const header = `## Session Summary (auto, exit: ${formatExitSummaryReason(reason)})`;
	return [`<!-- ${timestamp} [${sessionId}] -->`, header, "", summary.trim()].join("\n");
}

function getSessionBranch(ctx: ExtensionContext): SessionEntry[] | null {
	const sessionManager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
		getBranch?: () => SessionEntry[];
	};
	if (typeof sessionManager?.getBranch !== "function") {
		return null;
	}
	return sessionManager.getBranch();
}

async function resolveExitSummaryApiKey(ctx: ExtensionContext): Promise<string | undefined> {
	if (!ctx.model) return undefined;

	const modelRegistry = ctx.modelRegistry as ExtensionContext["modelRegistry"] & {
		getApiKey?: (model: NonNullable<ExtensionContext["model"]>) => Promise<string | undefined>;
		getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
	};

	if (typeof modelRegistry?.getApiKey === "function") {
		return modelRegistry.getApiKey(ctx.model);
	}

	if (typeof modelRegistry?.getApiKeyForProvider === "function") {
		return modelRegistry.getApiKeyForProvider(ctx.model.provider);
	}

	return undefined;
}

function serializeSessionConversation(branch: SessionEntry[]): { text: string; hasMessages: boolean } {
	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);
	if (messages.length === 0) return { text: "", hasMessages: false };
	return { text: serializeConversation(convertToLlm(messages)), hasMessages: true };
}

export function parseLearningExtractorResponse(raw: string): ReviewCandidateInput[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.trim());
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object" || !("candidates" in parsed) || !Array.isArray(parsed.candidates)) return [];
	const candidates: ReviewCandidateInput[] = [];
	for (const candidate of parsed.candidates) {
		if (!candidate || typeof candidate !== "object") continue;
		const record = candidate as Record<string, unknown>;
		const kind = typeof record.kind === "string" && REVIEW_CANDIDATE_KINDS.includes(record.kind as ReviewCandidateInput["kind"])
			? record.kind as ReviewCandidateInput["kind"]
			: undefined;
		const confidence = typeof record.confidence === "string" && REVIEW_CONFIDENCES.includes(record.confidence as ReviewCandidateInput["confidence"])
			? record.confidence as ReviewCandidateInput["confidence"]
			: undefined;
		const signature = typeof record.signature === "string" ? record.signature.trim() : "";
		if (!kind || !confidence || !signature || !shouldKeepLearningCandidate(confidence)) continue;
		const targetHints = Array.isArray(record.targetHints)
			? record.targetHints.filter((hint): hint is ReviewCandidateInput["targetHints"][number] => typeof hint === "string" && REVIEW_TARGET_HINTS.includes(hint as ReviewCandidateInput["targetHints"][number]))
			: undefined;
		candidates.push({
			kind,
			confidence,
			signature,
			summary: typeof record.summary === "string" ? record.summary.trim() : undefined,
			targetHints,
			evidence: typeof record.evidence === "string" ? record.evidence.trim() : undefined,
			source: "session_shutdown",
		});
	}
	return candidates;
}

async function runSessionLearningExtractor(ctx: ExtensionContext): Promise<number> {
	if (getMemoryLearningMode() === "off") return 0;
	const branch = getSessionBranch(ctx);
	if (!branch || !ctx.model) return 0;
	const apiKey = await resolveExitSummaryApiKey(ctx);
	if (!apiKey) return 0;
	const conversation = serializeSessionConversation(branch);
	if (!conversation.hasMessages || !conversation.text.trim()) return 0;
	const truncated = truncateText(conversation.text.trim(), LEARNING_EXTRACTOR_MAX_CHARS, "end");
	const messages: Message[] = [{
		role: "user",
		content: [{ type: "text", text: buildLearningExtractorPrompt(truncated.text, truncated.truncated, conversation.text.trim().length) }],
		timestamp: Date.now(),
	}];
	try {
		const response = await complete(ctx.model, { systemPrompt: LEARNING_EXTRACTOR_SYSTEM_PROMPT, messages }, { apiKey, reasoningEffort: "low" });
		const raw = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
		const candidates = parseLearningExtractorResponse(raw);
		let written = 0;
		const store = new FileMemoryStore(MEMORY_DIR);
		for (const candidate of candidates) {
			const result = await upsertReviewCandidate(store, candidate);
			if (result.changed) written += 1;
		}
		return written;
	} catch {
		return 0;
	}
}

async function generateExitSummary(ctx: ExtensionContext): Promise<ExitSummaryResult> {
	const branch = getSessionBranch(ctx);
	if (!branch) {
		return { summary: null, error: "Session branch unavailable", hasMessages: false };
	}

	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);

	if (messages.length === 0) {
		return { summary: null, hasMessages: false };
	}

	if (!ctx.model) {
		return { summary: null, error: "No active model", hasMessages: true };
	}

	const apiKey = await resolveExitSummaryApiKey(ctx);
	if (!apiKey) {
		return {
			summary: null,
			error: `API key resolution unavailable for ${ctx.model.provider}/${ctx.model.id}`,
			hasMessages: true,
		};
	}

	const conversationText = serializeConversation(convertToLlm(messages));
	const { text: truncatedText, truncated, totalChars } = truncateConversationForSummary(conversationText);
	if (!truncatedText.trim()) {
		return { summary: null, error: "No conversation text to summarize", hasMessages: true };
	}

	const summaryMessages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: buildExitSummaryPrompt(truncatedText, truncated, totalChars) }],
			timestamp: Date.now(),
		},
	];

	try {
		const response = await complete(
			ctx.model,
			{ systemPrompt: EXIT_SUMMARY_SYSTEM_PROMPT, messages: summaryMessages },
			{ apiKey, reasoningEffort: "low" },
		);

		const summaryText = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!summaryText) {
			return { summary: null, error: "Summary was empty", hasMessages: true };
		}

		return { summary: summaryText, hasMessages: true };
	} catch (err) {
		return { summary: null, error: err instanceof Error ? err.message : String(err), hasMessages: true };
	}
}

function getQmdUpdateMode(): "background" | "manual" | "off" {
	const mode = (process.env.PI_MEMORY_QMD_UPDATE ?? "background").toLowerCase();
	if (mode === "manual" || mode === "off" || mode === "background") {
		return mode;
	}
	return "background";
}

export function shouldSummarizeLifecycleTransitions(): boolean {
	const value = (process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS ?? "").toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function shouldSkipExitSummaryForReason(reason: string | undefined): boolean {
	if (!reason) return false;
	if (shouldSummarizeLifecycleTransitions()) return false;
	return ["reload", "new", "resume", "fork"].includes(reason);
}

export function shouldWriteTransitionHandoffForReason(reason: string | undefined): reason is TransitionHandoffReason {
	if (shouldSummarizeLifecycleTransitions()) return false;
	return reason === "new" || reason === "fork";
}

function formatTransitionHandoffReason(reason: TransitionHandoffReason): string {
	return `/${reason}`;
}

function getMessageText(message: Message): string {
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
}

function previewMessageText(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function buildTransitionHandoff(ctx: ExtensionContext, reason: TransitionHandoffReason, sessionId: string, timestamp: string): string | null {
	const parts: string[] = [];
	const branch = getSessionBranch(ctx);
	const recentMessages = (branch ?? [])
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message)
		.map((message) => ({ role: message.role, text: previewMessageText(getMessageText(message)) }))
		.filter((message) => message.text)
		.slice(-6);

	if (recentMessages.length > 0) {
		parts.push("### Recent conversation", "");
		for (const message of recentMessages) {
			parts.push(`- **${message.role}:** ${message.text}`);
		}
		parts.push("");
	}

	const scratchpad = readFileSafe(SCRATCHPAD_FILE);
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((item) => !item.done);
		if (openItems.length > 0) {
			parts.push("### Open scratchpad items", "");
			for (const item of openItems) {
				parts.push(`- [ ] ${item.text}`);
			}
			parts.push("");
		}
	}

	if (parts.length === 0) return null;

	return [
		`<!-- ${timestamp} [${sessionId}] -->`,
		`## Session Handoff (auto, transition: ${formatTransitionHandoffReason(reason)})`,
		"",
		...parts,
	].join("\n").trim();
}

async function writeTransitionHandoff(ctx: ExtensionContext, reason: TransitionHandoffReason): Promise<boolean> {
	ensureDirs();
	const sid = shortSessionId(ctx.sessionManager.getSessionId());
	const ts = nowTimestamp();
	const handoff = buildTransitionHandoff(ctx, reason, sid, ts);
	if (!handoff) return false;
	const filePath = dailyPath(todayStr());
	const existing = readFileSafe(filePath) ?? "";
	const separator = existing.trim() ? "\n\n" : "";
	fs.writeFileSync(filePath, existing + separator + handoff, "utf-8");
	await ensureQmdAvailableForUpdate();
	await runQmdUpdateNow();
	return true;
}

async function ensureQmdAvailableForUpdate(): Promise<boolean> {
	if (qmdAvailable) return true;
	if (getQmdUpdateMode() !== "background") return false;
	qmdAvailable = await detectQmd();
	return qmdAvailable;
}

// ---------------------------------------------------------------------------
// Scratchpad helpers
// ---------------------------------------------------------------------------

export interface ScratchpadItem {
	done: boolean;
	text: string;
	meta: string; // the <!-- timestamp [session] --> comment
}

export function parseScratchpad(content: string): ScratchpadItem[] {
	const items: ScratchpadItem[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^- \[([ xX])\] (.+)$/);
		if (match) {
			let meta = "";
			if (i > 0 && lines[i - 1].match(/^<!--.*-->$/)) {
				meta = lines[i - 1];
			}
			items.push({
				done: match[1].toLowerCase() === "x",
				text: match[2],
				meta,
			});
		}
	}
	return items;
}

export function serializeScratchpad(items: ScratchpadItem[]): string {
	const lines: string[] = ["# Scratchpad", ""];
	for (const item of items) {
		if (item.meta) {
			lines.push(item.meta);
		}
		const checkbox = item.done ? "[x]" : "[ ]";
		lines.push(`- ${checkbox} ${item.text}`);
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export function buildMemoryContext(searchResults?: string): string {
	ensureDirs();
	// Priority order: scratchpad > today's daily > search results > MEMORY.md > yesterday's daily
	const sections: string[] = [];

	const scratchpad = readFileSafe(SCRATCHPAD_FILE);
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
		if (openItems.length > 0) {
			const serialized = serializeScratchpad(openItems);
			const section = formatContextSection(
				"## SCRATCHPAD.md (working context)",
				serialized,
				"start",
				CONTEXT_SCRATCHPAD_MAX_LINES,
				CONTEXT_SCRATCHPAD_MAX_CHARS,
			);
			if (section) sections.push(section);
		}
	}

	const today = todayStr();
	const yesterday = yesterdayStr();

	const todayContent = readFileSafe(dailyPath(today));
	if (todayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${today} (today)`,
			todayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (searchResults?.trim()) {
		const section = formatContextSection(
			"## Relevant memories (auto-retrieved)",
			searchResults,
			"start",
			CONTEXT_SEARCH_MAX_LINES,
			CONTEXT_SEARCH_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const userProfile = readFileSafe(USER_FILE);
	if (userProfile?.trim()) {
		const section = formatContextSection(
			"## USER.md (user profile)",
			userProfile,
			"middle",
			CONTEXT_LONG_TERM_MAX_LINES,
			CONTEXT_LONG_TERM_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const stateEntries = readStructuredEntries("state").filter(isCurrentStructuredState);
	if (stateEntries.length > 0) {
		const section = formatContextSection(
			"## STATE.md (current state)",
			stateEntries.join(ENTRY_DELIMITER),
			"middle",
			CONTEXT_LONG_TERM_MAX_LINES,
			CONTEXT_LONG_TERM_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const longTerm = readFileSafe(MEMORY_FILE);
	if (longTerm?.trim()) {
		const section = formatContextSection(
			"## MEMORY.md (long-term)",
			longTerm,
			"middle",
			CONTEXT_LONG_TERM_MAX_LINES,
			CONTEXT_LONG_TERM_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const yesterdayContent = readFileSafe(dailyPath(yesterday));
	if (yesterdayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${yesterday} (yesterday)`,
			yesterdayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (sections.length === 0) {
		return "";
	}

	const context = `# Memory\n\n${sections.join("\n\n---\n\n")}`;
	if (context.length > CONTEXT_MAX_CHARS) {
		const result = buildPreview(context, {
			maxLines: Number.POSITIVE_INFINITY,
			maxChars: CONTEXT_MAX_CHARS,
			mode: "start",
		});
		const note = result.truncated
			? `\n\n[truncated overall context: showing ${result.previewChars}/${result.totalChars} chars]`
			: "";
		return `${result.preview}${note}`;
	}

	return context;
}

// ---------------------------------------------------------------------------
// QMD integration
// ---------------------------------------------------------------------------

type ExecFileFn = typeof execFile;

function isQmdCommand(file: string | URL): boolean {
	if (typeof file !== "string") return false;
	const basename = file.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return basename === "qmd" || basename === "qmd.cmd" || basename === "qmd.exe";
}

const QMD_JS_REL = path.join("node_modules", "@tobilu", "qmd", "dist", "cli", "qmd.js");

let cachedQmdJsPath: string | null | undefined;

// On Windows, cmd-shim writes the literal `/bin/sh` (the package's shebang
// interpreter) into both qmd.cmd and qmd.ps1, so both shims fail with
// "system cannot find the path specified" / "'/bin/sh.exe' is not recognized"
// outside cygwin/git-bash trees. Bypass the shims by locating qmd's JS entry
// in a sibling node_modules directory of a PATH entry and invoking it with
// node directly — the same thing the sh script in bin/qmd does when launched
// via npm.
export function resolveQmdJsPath(env: NodeJS.ProcessEnv = process.env): string | null {
	if (cachedQmdJsPath !== undefined) return cachedQmdJsPath;
	const pathStr = env.PATH ?? env.Path ?? "";
	const entries = pathStr.split(path.delimiter).filter(Boolean);
	for (const dir of entries) {
		try {
			const candidate = path.join(dir, QMD_JS_REL);
			if (fs.statSync(candidate).isFile()) {
				cachedQmdJsPath = candidate;
				return candidate;
			}
		} catch {
			// keep scanning
		}
	}
	cachedQmdJsPath = null;
	return null;
}

/** Clear the resolved qmd.js cache (for testing). */
export function _resetQmdJsResolutionForTest() {
	cachedQmdJsPath = undefined;
}

export function buildQmdSpawn(
	file: string,
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
	qmdJsPath: string | null = null,
): { file: string; args: string[] } {
	if (platform !== "win32" || !isQmdCommand(file) || !qmdJsPath) {
		return { file, args: [...args] };
	}
	return { file: "node", args: [qmdJsPath, ...args] };
}

const execFileWithQmdOptions: ExecFileFn = ((
	file: string,
	args: readonly string[],
	options: ExecFileOptions,
	callback: (...args: any[]) => void,
) => {
	const qmdJs = process.platform === "win32" && isQmdCommand(file) ? resolveQmdJsPath() : null;
	const spawn = buildQmdSpawn(file, args ?? [], process.platform, qmdJs);
	return execFile(spawn.file, spawn.args, options, callback as any);
}) as ExecFileFn;

let execFileFn: ExecFileFn = execFileWithQmdOptions;

let qmdAvailable = false;
let qmdAvailabilityCheckedAt = 0;
// Positive results are stable for the session; negative results should refresh
// quickly so users who install qmd (or run setupQmdCollection) mid-session
// don't have to wait through a long TTL before retries succeed.
const QMD_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const QMD_STATUS_NEGATIVE_CACHE_TTL_MS = 5 * 1000;
const qmdCollectionStatusCache = new Map<string, { checkedAt: number; exists: boolean }>();

function qmdStatusTtl(positive: boolean): number {
	return positive ? QMD_STATUS_CACHE_TTL_MS : QMD_STATUS_NEGATIVE_CACHE_TTL_MS;
}
let updateTimer: ReturnType<typeof setTimeout> | null = null;
let exitSummaryReason: ExitSummaryReason | null = null;
let terminalInputUnsubscribe: (() => void) | null = null;

/** Override execFile implementation (for testing). */
export function _setExecFileForTest(fn: ExecFileFn) {
	execFileFn = fn;
}

/** Reset execFile implementation (for testing). */
export function _resetExecFileForTest() {
	execFileFn = execFileWithQmdOptions;
}

/** Set qmd availability flag (for testing). */
export function _setQmdAvailable(value: boolean) {
	qmdAvailable = value;
	qmdAvailabilityCheckedAt = Date.now();
}

/** Get current qmd availability flag (for testing). */
export function _getQmdAvailable(): boolean {
	return qmdAvailable;
}

/** Get current update timer (for testing). */
export function _getUpdateTimer(): ReturnType<typeof setTimeout> | null {
	return updateTimer;
}

/** Clear the update timer (for testing). */
export function _clearUpdateTimer() {
	if (updateTimer) {
		clearTimeout(updateTimer);
		updateTimer = null;
	}
}

/** Clear qmd status caches (for testing). */
export function _clearQmdStatusCaches() {
	qmdAvailabilityCheckedAt = 0;
	qmdCollectionStatusCache.clear();
}

const QMD_REPO_URL = "https://github.com/tobi/qmd";

export function qmdInstallInstructions(): string {
	return [
		"memory_search requires qmd.",
		"",
		"Install qmd (requires Bun):",
		`  bun install -g ${QMD_REPO_URL}`,
		"  # ensure ~/.bun/bin is in your PATH",
		"",
		"Then set up the collection (one-time):",
		`  qmd collection add ${MEMORY_DIR} --name pi-memory`,
		"  qmd embed",
	].join("\n");
}

export function qmdCollectionInstructions(): string {
	return [
		"qmd collection pi-memory is not configured.",
		"",
		"Set up the collection (one-time):",
		`  qmd collection add ${MEMORY_DIR} --name pi-memory`,
		"  qmd embed",
	].join("\n");
}

/** Auto-create the pi-memory collection and path contexts in qmd. */
export async function setupQmdCollection(): Promise<boolean> {
	try {
		await new Promise<void>((resolve, reject) => {
			execFileFn("qmd", ["collection", "add", MEMORY_DIR, "--name", "pi-memory"], { timeout: 10_000 }, (err) =>
				err ? reject(err) : resolve(),
			);
		});
	} catch {
		// Collection may already exist under a different name — not critical
		return false;
	}

	// Add path contexts (best-effort, ignore errors)
	const contexts: [string, string][] = [
		["/daily", "Daily append-only work logs organized by date"],
		["/STATE.md", "Current dated state, events, temporary facts, and quotas"],
		["/USER.md", "Structured user profile and preferences"],
		["/REVIEW.md", "Memory review queue for stale or merge-candidate entries"],
		["/", "Curated long-term memory: decisions, preferences, facts, lessons"],
	];
	for (const [ctxPath, desc] of contexts) {
		try {
			await new Promise<void>((resolve, reject) => {
				execFileFn("qmd", ["context", "add", ctxPath, desc, "-c", "pi-memory"], { timeout: 10_000 }, (err) =>
					err ? reject(err) : resolve(),
				);
			});
		} catch {
			// Ignore — context may already exist
		}
	}
	// Seed the cache so checkCollection("pi-memory") doesn't redundantly re-run
	// setupQmdCollection during the short negative-cache window.
	qmdCollectionStatusCache.set("pi-memory", { checkedAt: Date.now(), exists: true });
	return true;
}

export function detectQmd(): Promise<boolean> {
	const now = Date.now();
	if (qmdAvailabilityCheckedAt && now - qmdAvailabilityCheckedAt < qmdStatusTtl(qmdAvailable)) {
		return Promise.resolve(qmdAvailable);
	}

	return new Promise((resolve) => {
		// `qmd status` can trigger slow model/device probing on some systems (e.g. Vulkan fallback),
		// which may exceed short startup timeouts and produce false negatives.
		// `qmd collection list` is much lighter and still validates the binary is callable.
		execFileFn("qmd", ["collection", "list"], { timeout: 15_000 }, (err) => {
			qmdAvailable = !err;
			qmdAvailabilityCheckedAt = Date.now();
			resolve(qmdAvailable);
		});
	});
}

export function checkCollection(name: string): Promise<boolean> {
	const cached = qmdCollectionStatusCache.get(name);
	const now = Date.now();
	if (cached && now - cached.checkedAt < qmdStatusTtl(cached.exists)) {
		return Promise.resolve(cached.exists);
	}

	return new Promise((resolve) => {
		execFileFn("qmd", ["collection", "list", "--json"], { timeout: 10_000 }, (err, stdout) => {
			let exists = false;
			if (!err) {
				try {
					const collections = JSON.parse(stdout);
					if (Array.isArray(collections)) {
						exists = collections.some((entry) => {
							if (typeof entry === "string") return entry === name;
							if (entry && typeof entry === "object" && "name" in entry) {
								return (entry as { name?: string }).name === name;
							}
							return false;
						});
					} else {
						// qmd may output an object with a collections array or similar
						exists = stdout.includes(name);
					}
				} catch {
					// Fallback: just check if the name appears in the output
					exists = stdout.includes(name);
				}
			}
			qmdCollectionStatusCache.set(name, { checkedAt: Date.now(), exists });
			resolve(exists);
		});
	});
}

export function scheduleQmdUpdate() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	if (updateTimer) clearTimeout(updateTimer);
	updateTimer = setTimeout(() => {
		updateTimer = null;
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => {});
	}, 500);
}

async function runQmdUpdateNow() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	await new Promise<void>((resolve) => {
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => resolve());
	});
}

/** Search for memories relevant to the user's prompt. Returns formatted markdown or empty string on error. */
export async function searchRelevantMemories(prompt: string): Promise<string> {
	if (!qmdAvailable || !prompt.trim()) return "";

	// Sanitize: strip control chars, limit to 200 chars for the search query
	const sanitized = prompt
		// biome-ignore lint/suspicious/noControlCharactersInRegex: we intentionally strip control chars.
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.trim()
		.slice(0, 200);
	if (!sanitized) return "";

	try {
		const hasCollection = await checkCollection("pi-memory");
		if (!hasCollection) return "";

		const results = await Promise.race([
			runQmdSearch("keyword", sanitized, 3),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3_000)),
		]);

		if (!results || results.results.length === 0) return "";

		const snippets = results.results
			.map((r) => {
				const text = getQmdResultText(r);
				if (!text.trim()) return null;
				const filePath = getQmdResultPath(r);
				const filePart = filePath ? `_${filePath}_` : "";
				return filePart ? `${filePart}\n${text.trim()}` : text.trim();
			})
			.filter(Boolean);

		if (snippets.length === 0) return "";
		return snippets.join("\n\n---\n\n");
	} catch {
		return "";
	}
}

export interface QmdSearchResult {
	path?: string;
	file?: string;
	score?: number;
	content?: string;
	chunk?: string;
	snippet?: string;
	title?: string;
	[key: string]: unknown;
}

function getQmdResultPath(r: QmdSearchResult): string | undefined {
	return r.path ?? r.file;
}

function getQmdResultText(r: QmdSearchResult): string {
	return r.content ?? r.chunk ?? r.snippet ?? "";
}

function stripAnsi(text: string): string {
	// qmd may emit spinners/progress bars even with --json, especially on first model download.
	// Strip ANSI CSI/OSC sequences so we can reliably find and parse JSON payloads.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences
	return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

function parseQmdJson(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	if (trimmed === "No results found." || trimmed === "No results found") return [];

	const cleaned = stripAnsi(stdout);
	const lines = cleaned.split(/\r?\n/);
	const startLine = lines.findIndex((l) => {
		const s = l.trimStart();
		return s.startsWith("[") || s.startsWith("{");
	});
	if (startLine === -1) {
		throw new Error(`Failed to parse qmd output: ${trimmed.slice(0, 200)}`);
	}

	const jsonText = lines.slice(startLine).join("\n").trim();
	if (!jsonText) return [];
	return JSON.parse(jsonText);
}

export function runQmdSearch(
	mode: "keyword" | "semantic" | "deep",
	query: string,
	limit: number,
): Promise<{ results: QmdSearchResult[]; stderr: string }> {
	const subcommand = mode === "keyword" ? "search" : mode === "semantic" ? "vsearch" : "query";
	const args = [subcommand, "--json", "-c", "pi-memory", "-n", String(limit), query];

	return new Promise((resolve, reject) => {
		execFileFn("qmd", args, { timeout: 60_000 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(stderr?.trim() || err.message));
				return;
			}
			try {
				const parsed = parseQmdJson(stdout);
				const results = Array.isArray(parsed) ? parsed : ((parsed as any).results ?? (parsed as any).hits ?? []);
				resolve({ results, stderr: stderr ?? "" });
			} catch (parseErr) {
				if (parseErr instanceof Error) {
					reject(parseErr);
					return;
				}
				reject(new Error(`Failed to parse qmd output: ${stdout.slice(0, 200)}`));
			}
		});
	});
}

// ---------------------------------------------------------------------------
// Memory snapshot (Option P: KV cache-stable context injection)
//
// The system prompt must be byte-stable across turns so local prefix caches
// (llama.cpp, vLLM, MLX) don't invalidate the entire conversation tail on each
// turn. We snapshot the memory context at deliberate checkpoints
// (session_start, session_before_compact, long_term writes, day rollover) and
// emit the same bytes for every turn in between.
// ---------------------------------------------------------------------------

let memorySnapshot: string | null = null;
let snapshotTakenAt: string | null = null;
let snapshotTakenOnDate: string | null = null;
let snapshotReason: string | null = null;
let snapshotDirty = false;

function refreshMemorySnapshot(reason: string) {
	memorySnapshot = buildMemoryContext("");
	snapshotTakenAt = nowTimestamp();
	snapshotTakenOnDate = todayStr();
	snapshotReason = reason;
	snapshotDirty = false;
}

function getSnapshotMode(): "stable" | "per-turn" {
	const mode = (process.env.PI_MEMORY_SNAPSHOT ?? "stable").toLowerCase();
	return mode === "per-turn" ? "per-turn" : "stable";
}


async function runCurator(reason: string): Promise<string> {
	ensureDirs();
	const store = new FileMemoryStore(MEMORY_DIR);
	const result = await runMemoryCuratorOnce({
		memoryStore: store,
		auditLog: new JsonlAuditLog(MEMORY_DIR),
		reason,
	});
	const lifecycleResult = await applyReviewLifecycle(store);
	const memoryResult = await proposeMemoryPromotions(store);
	const skillResult = getMemorySkillDraftsMode() === "off" ? { created: 0, proposals: [] } : await proposeSkillDrafts(store, { draftsDir: SKILL_DRAFTS_DIR });
	let autoApprovedMemory = 0;
	let autoApprovedSkills = 0;
	if (getMemoryAutoApproveMemory()) {
		for (const id of memoryResult.proposalIds) {
			await approveMemoryPromotion(store, id);
			autoApprovedMemory += 1;
		}
	}
	if (getMemoryAutoApproveSkillDrafts()) {
		for (const proposal of skillResult.proposals) {
			await approveSkillDraft(store, proposal.id);
			autoApprovedSkills += 1;
		}
	}
	const learningChanges = lifecycleResult.changed + memoryResult.created + skillResult.created + autoApprovedMemory + autoApprovedSkills;
	if (result.patches.length > 0 || learningChanges > 0) {
		snapshotDirty = true;
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
	}
	const notes = [
		memoryResult.created > 0 ? `proposed ${memoryResult.created} memory promotion(s)` : "",
		skillResult.created > 0 ? `proposed ${skillResult.created} skill draft(s)` : "",
		autoApprovedMemory > 0 ? `auto-approved ${autoApprovedMemory} memory promotion(s)` : "",
		autoApprovedSkills > 0 ? `auto-approved ${autoApprovedSkills} skill draft(s)` : "",
	].filter(Boolean);
	return notes.length > 0 ? `${result.summary}; ${notes.join("; ")}` : result.summary;
}

/** Reset snapshot state (for testing). */
export function _resetMemorySnapshot() {
	memorySnapshot = null;
	snapshotTakenAt = null;
	snapshotTakenOnDate = null;
	snapshotReason = null;
	snapshotDirty = false;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// --- session_start: detect qmd, auto-setup collection ---
	pi.on("session_start", async (_event, ctx) => {
		ensureDirs();
		exitSummaryReason = null;
		if (terminalInputUnsubscribe) {
			terminalInputUnsubscribe();
			terminalInputUnsubscribe = null;
		}
		if (ctx.hasUI) {
			terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
				if (!data.includes("\u0004")) return undefined;
				if (!ctx.isIdle()) return undefined;
				if (ctx.ui.getEditorText().trim()) return undefined;
				exitSummaryReason = "ctrl+d";
				return undefined;
			});
		}

		qmdAvailable = await detectQmd();
		if (!qmdAvailable) {
			if (ctx.hasUI) {
				ctx.ui.notify(qmdInstallInstructions(), "info");
			}
			refreshMemorySnapshot("session_start");
			return;
		}

		const hasCollection = await checkCollection("pi-memory");
		if (!hasCollection) {
			await setupQmdCollection();
		}
		refreshMemorySnapshot("session_start");
	});

	// --- session_shutdown: write exit summary + clean up timer ---
	pi.on("session_shutdown", async (event, ctx) => {
		const shutdownReason = (event as { reason?: string }).reason;

		if (terminalInputUnsubscribe) {
			terminalInputUnsubscribe();
			terminalInputUnsubscribe = null;
		}

		// Lifecycle transitions are usually not final session exits. By default,
		// avoid generating LLM summaries during /reload, /new, /resume, and
		// /fork because that makes transitions slow. Keep /reload and /resume
		// silent, but write a cheap handoff for /new and /fork so useful context
		// survives the transition. Users who prefer full summaries can opt in
		// with PI_MEMORY_SUMMARIZE_TRANSITIONS=1.
		if (shouldSkipExitSummaryForReason(shutdownReason)) {
			try {
				if (shouldWriteTransitionHandoffForReason(shutdownReason)) {
					await writeTransitionHandoff(ctx, shutdownReason);
				}
			} finally {
				exitSummaryReason = null;
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = null;
				}
			}
			return;
		}

		const reason = exitSummaryReason ?? "session-end";
		exitSummaryReason = null;

		try {
			if (reason) {
				ensureDirs();
				const result = await generateExitSummary(ctx);
				if (result.hasMessages) {
					const summary = result.summary ?? buildExitSummaryFallback(result.error);
					const sid = shortSessionId(ctx.sessionManager.getSessionId());
					const ts = nowTimestamp();
					const entry = formatExitSummaryEntry(summary, reason, sid, ts);
					const filePath = dailyPath(todayStr());
					const existing = readFileSafe(filePath) ?? "";
					const separator = existing.trim() ? "\n\n" : "";
					fs.writeFileSync(filePath, existing + separator + entry, "utf-8");
					await runSessionLearningExtractor(ctx);
					await ensureQmdAvailableForUpdate();
					await runQmdUpdateNow();
				}
			}
		} finally {
			if (updateTimer) {
				clearTimeout(updateTimer);
				updateTimer = null;
			}
		}
	});

	// --- input: detect /quit for shutdown summary ---
	pi.on("input", async (event, _ctx) => {
		if (event.source !== "extension" && event.text.trim() === "/quit") {
			exitSummaryReason = "slash-quit";
		}
		return { action: "continue" };
	});

	// --- Inject memory context before every agent turn ---
	pi.on("before_agent_start", async (event, _ctx) => {
		const mode = getSnapshotMode();

		let memoryContext: string;
		let snapshotCaveat = "";

		if (mode === "per-turn") {
			const skipSearch = process.env.PI_MEMORY_NO_SEARCH === "1";
			const searchResults = skipSearch ? "" : await searchRelevantMemories(event.prompt ?? "");
			memoryContext = buildMemoryContext(searchResults);
		} else {
			const today = todayStr();
			const needsRefresh = memorySnapshot === null || snapshotDirty || snapshotTakenOnDate !== today;
			if (needsRefresh) {
				const reason =
					memorySnapshot === null ? "before_agent_start" : snapshotDirty ? "long_term_write" : "day_rollover";
				refreshMemorySnapshot(reason);
			}
			memoryContext = memorySnapshot ?? "";
			snapshotCaveat =
				`Snapshot ${snapshotReason} at ${snapshotTakenAt}. ` +
				"Use memory_read / memory_search for the authoritative latest state; " +
				"recent writes may also be visible in tool-call history.";
		}

		if (!memoryContext) return;

		const headerLines = ["\n\n## Memory"];
		if (snapshotCaveat) headerLines.push(`(${snapshotCaveat})`);
		headerLines.push(
			"The following memory files have been loaded. Use the memory_write tool to persist important information.",
			"- Decisions, preferences, and durable facts \u2192 MEMORY.md",
			"- Structured user profile \u2192 USER.md",
			"- Current dated state, events, temporary facts, and quotas \u2192 STATE.md",
			"- Memory review queue \u2192 REVIEW.md",
			"- Day-to-day notes and running context \u2192 daily/<YYYY-MM-DD>.md",
			"- Things to fix later or keep in mind \u2192 scratchpad tool",
			"- Use memory_search to find past context across all memory files (keyword, semantic, or deep search).",
			"- Use #tags (e.g. #decision, #preference) and [[links]] (e.g. [[auth-strategy]]) in memory content to improve future search recall.",
			'- If someone says "remember this," write it immediately.',
			"",
			memoryContext,
		);

		return {
			systemPrompt: event.systemPrompt + headerLines.join("\n"),
		};
	});

	// --- Pre-compaction: auto-capture session handoff ---
	pi.on("session_before_compact", async (_event, ctx) => {
		ensureDirs();
		const sid = shortSessionId(ctx.sessionManager.getSessionId());
		const ts = nowTimestamp();
		const parts: string[] = [];

		// Capture open scratchpad items
		const scratchpad = readFileSafe(SCRATCHPAD_FILE);
		if (scratchpad?.trim()) {
			const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
			if (openItems.length > 0) {
				parts.push("**Open scratchpad items:**");
				for (const item of openItems) {
					parts.push(`- [ ] ${item.text}`);
				}
			}
		}

		// Capture last few lines from today's daily log
		const todayContent = readFileSafe(dailyPath(todayStr()));
		if (todayContent?.trim()) {
			const lines = todayContent.trim().split("\n");
			const tail = lines.slice(-15).join("\n");
			parts.push(`**Recent daily log context:**\n${tail}`);
		}

		// Intentional cache boundary: compaction drops tool history, so the
		// snapshot must catch up to disk on every compaction — even when no
		// handoff is written. Otherwise stale pre-compaction state (e.g. a
		// completed scratchpad item that no longer appears in the snapshot
		// source files) would keep being injected.
		try {
			if (parts.length === 0) return;

			const handoff = [`<!-- HANDOFF ${ts} [${sid}] -->`, "## Session Handoff", ...parts].join("\n");

			const filePath = dailyPath(todayStr());
			const existing = readFileSafe(filePath) ?? "";
			const separator = existing.trim() ? "\n\n" : "";
			fs.writeFileSync(filePath, existing + separator + handoff, "utf-8");
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
		} finally {
			refreshMemorySnapshot("session_before_compact");
		}
	});

	// --- memory_write tool ---
	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: [
			"Write to memory files. Supports plain pi-memory targets plus structured time-aware targets:",
			"- 'long_term': append/overwrite MEMORY.md for durable facts, decisions, and preferences.",
			"- 'daily': append to today's daily log (daily/<YYYY-MM-DD>.md).",
			"- 'state': append structured time-aware entries to STATE.md. Use this for events, temporary facts, quotas, and dated state.",
			"- 'user': append structured user-profile entries to USER.md.",
			"- 'review': append structured review entries to REVIEW.md.",
			"For time-sensitive facts, prefer target='state' with type='event', 'temporary', or 'quota' so the curator can maintain them.",
		].join("\n"),
		promptSnippet: "Write memory. Use target='state' plus metadata for time-sensitive event/temporary/quota facts so the curator can maintain them.",
		parameters: Type.Object({
			target: StringEnum(MEMORY_WRITE_TARGETS, { description: "Where to write memory" }),
			content: Type.String({ description: "Memory content" }),
			mode: Type.Optional(StringEnum(["append", "overwrite"] as const, { description: "Only applies to long_term. Default: append." })),
			type: Type.Optional(StringEnum(STRUCTURED_MEMORY_TYPES, { description: "Structured metadata type for state/user/review targets" })),
			status: Type.Optional(Type.String({ description: "Structured status, e.g. planned, today, past, active, exhausted, archived" })),
			date: Type.Optional(Type.String({ description: "Date for event/temporary entries, YYYY-MM-DD" })),
			reset: Type.Optional(Type.String({ description: "Quota reset date/time" })),
			month: Type.Optional(Type.String({ description: "Quota month, YYYY-MM" })),
			provider: Type.Optional(Type.String({ description: "Quota provider" })),
			used: Type.Optional(Type.String({ description: "Quota used count" })),
			limit: Type.Optional(Type.String({ description: "Quota limit count" })),
			ttlDays: Type.Optional(Type.String({ description: "Temporary memory TTL in days" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureDirs();
			const target = params.target as MemoryWriteTarget;
			const content = params.content.trim();
			if (!content) {
				return { content: [{ type: "text", text: "Error: content is required." }], isError: true, details: {} };
			}
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			if (target === "daily") {
				const filePath = dailyPath(todayStr());
				const existing = readFileSafe(filePath) ?? "";
				const existingPreview = buildPreview(existing, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "end",
				});
				const existingSnippet = existingPreview.preview
					? `\n\n${formatPreviewBlock("Existing daily log preview", existing, "end")}`
					: "\n\nDaily log was empty.";

				const separator = existing.trim() ? "\n\n" : "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(filePath, existing + separator + stamped, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [{ type: "text", text: `Appended to daily log: ${filePath}${existingSnippet}` }],
					details: { path: filePath, target, mode: "append", sessionId: sid, timestamp: ts, qmdUpdateMode: getQmdUpdateMode(), existingPreview },
				};
			}

			if (target === "long_term") {
				const existing = readFileSafe(MEMORY_FILE) ?? "";
				const existingPreview = buildPreview(existing, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "middle",
				});
				const existingSnippet = existingPreview.preview
					? `\n\n${formatPreviewBlock("Existing MEMORY.md preview", existing, "middle")}`
					: "\n\nMEMORY.md was empty.";

				snapshotDirty = true;
				if (params.mode === "overwrite") {
					const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
					fs.writeFileSync(MEMORY_FILE, stamped, "utf-8");
					await ensureQmdAvailableForUpdate();
					scheduleQmdUpdate();
					return {
						content: [{ type: "text", text: `Overwrote MEMORY.md${existingSnippet}` }],
						details: { path: MEMORY_FILE, target, mode: "overwrite", sessionId: sid, timestamp: ts, qmdUpdateMode: getQmdUpdateMode(), existingPreview },
					};
				}

				const separator = existing.trim() ? "\n\n" : "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(MEMORY_FILE, existing + separator + stamped, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [{ type: "text", text: `Appended to MEMORY.md${existingSnippet}` }],
					details: { path: MEMORY_FILE, target, mode: "append", sessionId: sid, timestamp: ts, qmdUpdateMode: getQmdUpdateMode(), existingPreview },
				};
			}

			const entry = buildStructuredEntry({
				target,
				content,
				type: params.type,
				status: params.status,
				date: params.date,
				reset: params.reset,
				month: params.month,
				provider: params.provider,
				used: params.used,
				limit: params.limit,
				ttlDays: params.ttlDays,
			});
			const added = addStructuredEntry(target, entry);
			snapshotDirty = true;
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			return {
				content: [{ type: "text", text: added ? `Added to ${target}: ${structuredMemoryPath(target)}` : `Entry already exists in ${target}: ${structuredMemoryPath(target)}` }],
				details: { path: structuredMemoryPath(target), target, mode: "append", sessionId: sid, timestamp: ts, entry, qmdUpdateMode: getQmdUpdateMode() },
			};
		},
	});

	// --- scratchpad tool ---
	pi.registerTool({
		name: "scratchpad",
		label: "Scratchpad",
		description: [
			"Manage a checklist of things to fix later or keep in mind. Actions:",
			"- 'add': Add a new unchecked item (- [ ] text)",
			"- 'done': Mark an item as done (- [x] text). Match by substring.",
			"- 'undo': Uncheck a done item back to open. Match by substring.",
			"- 'clear_done': Remove all checked items from the list.",
			"- 'list': Show all items.",
		].join("\n"),
		parameters: Type.Object({
			action: StringEnum(["add", "done", "undo", "clear_done", "list"] as const, {
				description: "What to do",
			}),
			text: Type.Optional(
				Type.String({
					description: "Item text for add, or substring to match for done/undo",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureDirs();
			const { action, text } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			const existing = readFileSafe(SCRATCHPAD_FILE) ?? "";
			let items = parseScratchpad(existing);

			if (action === "list") {
				if (items.length === 0) {
					return {
						content: [{ type: "text", text: "Scratchpad is empty." }],
						details: {},
					};
				}
				const serialized = serializeScratchpad(items);
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				return {
					content: [
						{
							type: "text",
							text: formatPreviewBlock("Scratchpad preview", serialized, "start"),
						},
					],
					details: {
						count: items.length,
						open: items.filter((i) => !i.done).length,
						preview,
					},
				};
			}

			if (action === "add") {
				if (!text) {
					return {
						content: [{ type: "text", text: "Error: 'text' is required for add." }],
						details: {},
					};
				}
				items.push({ done: false, text, meta: `<!-- ${ts} [${sid}] -->` });
				const serialized = serializeScratchpad(items);
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Added: - [ ] ${text}\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			if (action === "done" || action === "undo") {
				if (!text) {
					return {
						content: [
							{
								type: "text",
								text: `Error: 'text' is required for ${action}.`,
							},
						],
						details: {},
					};
				}
				const needle = text.toLowerCase();
				const targetDone = action === "done";
				let matched = false;
				for (const item of items) {
					if (item.done !== targetDone && item.text.toLowerCase().includes(needle)) {
						item.done = targetDone;
						matched = true;
						break;
					}
				}
				if (!matched) {
					return {
						content: [
							{
								type: "text",
								text: `No matching ${targetDone ? "open" : "done"} item found for: "${text}"`,
							},
						],
						details: {},
					};
				}
				const serialized = serializeScratchpad(items);
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Updated.\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			if (action === "clear_done") {
				const before = items.length;
				items = items.filter((i) => !i.done);
				const removed = before - items.length;
				const serialized = serializeScratchpad(items);
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Cleared ${removed} done item(s).\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						removed,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
				details: {},
			};
		},
	});

	// --- memory_read tool ---
	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description: [
			"Read a memory file. Targets:",
			"- 'long_term': Read MEMORY.md",
			"- 'user': Read USER.md",
			"- 'state': Read STATE.md",
			"- 'review': Read REVIEW.md",
			"- 'all': Read MEMORY.md, USER.md, STATE.md, REVIEW.md, SCRATCHPAD.md, and today's daily log.",
			"- 'scratchpad': Read SCRATCHPAD.md",
			"- 'daily': Read a specific day's log (default: today). Pass date as YYYY-MM-DD.",
			"- 'list': List all daily log files.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(MEMORY_READ_TARGETS, { description: "What to read" }),
			date: Type.Optional(Type.String({ description: "Date for daily log (YYYY-MM-DD). Default: today." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			ensureDirs();
			const target = params.target as MemoryReadTarget;
			const date = params.date;

			if (target === "list") {
				try {
					const files = fs.readdirSync(DAILY_DIR).filter((f) => f.endsWith(".md")).sort().reverse();
					if (files.length === 0) return { content: [{ type: "text", text: "No daily logs found." }], details: {} };
					return { content: [{ type: "text", text: `Daily logs:\n${files.map((f) => `- ${f}`).join("\n")}` }], details: { files } };
				} catch {
					return { content: [{ type: "text", text: "No daily logs directory." }], details: {} };
				}
			}

			if (target === "daily") {
				const d = date ?? todayStr();
				if (!isValidDailyDate(d)) {
					return { content: [{ type: "text", text: `Invalid date format: ${d}. Use YYYY-MM-DD.` }], isError: true, details: { date: d } };
				}
				const filePath = dailyPath(d);
				const content = readFileSafe(filePath);
				if (!content) return { content: [{ type: "text", text: `No daily log for ${d}.` }], details: {} };
				return { content: [{ type: "text", text: content }], details: { path: filePath, date: d } };
			}

			if (target === "scratchpad") {
				const content = readFileSafe(SCRATCHPAD_FILE);
				if (!content?.trim()) return { content: [{ type: "text", text: "SCRATCHPAD.md is empty or does not exist." }], details: {} };
				return { content: [{ type: "text", text: content }], details: { path: SCRATCHPAD_FILE } };
			}

			if (target === "all") {
				const parts: string[] = [];
				for (const structuredTarget of STRUCTURED_MEMORY_TARGETS) {
					const filePath = structuredMemoryPath(structuredTarget);
					const content = readFileSafe(filePath)?.trim();
					parts.push(`## ${path.basename(filePath)}\n\n${content || "empty"}`);
				}
				const scratchpad = readFileSafe(SCRATCHPAD_FILE)?.trim();
				parts.push(`## SCRATCHPAD.md\n\n${scratchpad || "empty"}`);
				const todayPath = dailyPath(todayStr());
				const todayContent = readFileSafe(todayPath)?.trim();
				parts.push(`## daily/${todayStr()}.md\n\n${todayContent || "empty"}`);
				return { content: [{ type: "text", text: parts.join("\n\n---\n\n") }], details: { target } };
			}

			const structuredTarget = target === "long_term" ? "memory" : normalizeStructuredMemoryTarget(target);
			const filePath = structuredMemoryPath(structuredTarget);
			const content = readFileSafe(filePath);
			if (!content?.trim()) return { content: [{ type: "text", text: `${path.basename(filePath)} is empty or does not exist.` }], details: {} };
			return { content: [{ type: "text", text: content }], details: { path: filePath } };
		},
	});

	// --- memory_edit tool ---
	pi.registerTool({
		name: "memory_edit",
		label: "Memory Edit",
		description: "Edit structured memory stores (MEMORY.md, USER.md, STATE.md, REVIEW.md) by entry delimiter. Supports read, add, replace, remove, replace_all, and compact.",
		promptSnippet: "Edit structured memory entries when a user asks to update or remove existing memory.",
		parameters: Type.Object({
			action: StringEnum(MEMORY_EDIT_ACTIONS, { description: "Memory edit action" }),
			target: Type.Optional(StringEnum(STRUCTURED_MEMORY_TARGETS, { description: "Memory store target" })),
			content: Type.Optional(Type.String({ description: "Entry content for add/replace/replace_all" })),
			oldText: Type.Optional(Type.String({ description: "Unique substring for replace/remove" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const action = params.action as MemoryEditAction;
				const target = normalizeStructuredMemoryTarget(params.target);
				let text: string;
				if (action === "read") text = formatStructuredEntries(target);
				else if (action === "add") {
					if (!params.content?.trim()) throw new Error("content is required");
					const added = addStructuredEntry(target, params.content);
					text = added ? `Added to ${target}.` : `Entry already exists in ${target}.`;
				} else if (action === "replace") text = replaceStructuredEntry(target, params.oldText || "", params.content || "");
				else if (action === "remove") text = removeStructuredEntry(target, params.oldText || "");
				else if (action === "replace_all") text = replaceAllStructuredEntries(target, params.content || "");
				else text = compactStructuredEntries(target);
				snapshotDirty = true;
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return { content: [{ type: "text", text }], details: { action, target, path: structuredMemoryPath(target) } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
			}
		},
	});

	// --- memory learning tools ---
	pi.registerTool({
		name: "memory_learning_approve",
		label: "Memory Learning Approve",
		description: "Approve a target-specific learning proposal by exact id. Skill approvals create disabled skill drafts only.",
		parameters: Type.Object({
			id: Type.String({ description: "Exact proposal id, for example skill_abcd1234" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const store = new FileMemoryStore(MEMORY_DIR);
				try {
					const memoryResult = await approveMemoryPromotion(store, params.id);
					snapshotDirty = true;
					await ensureQmdAvailableForUpdate();
					scheduleQmdUpdate();
					return { content: [{ type: "text", text: `Approved ${memoryResult.proposalId}. Wrote ${memoryResult.target}.` }], details: memoryResult };
				} catch {
					const skillResult = await approveSkillDraft(store, params.id);
					snapshotDirty = true;
					await ensureQmdAvailableForUpdate();
					scheduleQmdUpdate();
					return { content: [{ type: "text", text: `Approved ${skillResult.proposalId}. Created skill draft: ${skillResult.path}` }], details: skillResult };
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "memory_learning_reject",
		label: "Memory Learning Reject",
		description: "Reject or archive a review candidate/proposal by exact id without deleting it.",
		parameters: Type.Object({
			id: Type.String({ description: "Exact review id" }),
			status: Type.Optional(StringEnum(["rejected", "archived"] as const, { description: "Status to apply. Default rejected." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				await rejectReviewItem(new FileMemoryStore(MEMORY_DIR), params.id, params.status as "rejected" | "archived" | undefined);
				snapshotDirty = true;
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return { content: [{ type: "text", text: `Marked ${params.id} as ${params.status || "rejected"}.` }], details: { id: params.id, status: params.status || "rejected" } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "memory_skill_drafts",
		label: "Memory Skill Drafts",
		description: "List proposed skill drafts from REVIEW.md.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const proposals = await listSkillDraftProposals(new FileMemoryStore(MEMORY_DIR));
			if (proposals.length === 0) return { content: [{ type: "text", text: "No skill draft proposals." }], details: { proposals } };
			const text = proposals.map((proposal) => [`- ${proposal.id}: ${proposal.title}`, `  ${proposal.description}`, `  -> ${proposal.promotesTo}`].join("\n")).join("\n");
			return { content: [{ type: "text", text }], details: { proposals } };
		},
	});

	// --- memory_curate tool ---
	pi.registerTool({
		name: "memory_curate",
		label: "Memory Curate",
		description: "Run the time-aware memory curator now. It deduplicates exact entries, updates event/quota lifecycle metadata, and appends stale temporary memories to REVIEW.md.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const summary = await runCurator("memory_curate tool");
				return { content: [{ type: "text", text: summary }], details: { summary } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
			}
		},
	});


	// --- memory curator service tools ---
	pi.registerTool({
		name: "memory_curator_enable",
		label: "Memory Curator Enable",
		description: "Enable the external daily memory curator service. Uses a systemd user timer when available, with cron fallback, so curation can run even when pi is closed.",
		parameters: Type.Object({
			schedule: Type.Optional(Type.String({ description: "Daily schedule as HH:MM. Default: 03:00." })),
		}),
		async execute(_toolCallId, params) {
			const result = enableCuratorService({ memoryDir: MEMORY_DIR, cliPath: new URL("./src/cli.ts", import.meta.url).pathname, schedule: params.schedule });
			return { content: [{ type: "text", text: result.message }], details: result, isError: !result.ok };
		},
	});

	pi.registerTool({
		name: "memory_curator_disable",
		label: "Memory Curator Disable",
		description: "Disable and uninstall the external daily memory curator service.",
		parameters: Type.Object({}),
		async execute() {
			const result = disableCuratorService({ memoryDir: MEMORY_DIR, cliPath: new URL("./src/cli.ts", import.meta.url).pathname });
			return { content: [{ type: "text", text: result.message }], details: result, isError: !result.ok };
		},
	});

	pi.registerTool({
		name: "memory_curator_status",
		label: "Memory Curator Status",
		description: "Show whether the external daily memory curator service is enabled and which backend it uses.",
		parameters: Type.Object({}),
		async execute() {
			const result = getCuratorServiceStatus({ memoryDir: MEMORY_DIR, cliPath: new URL("./src/cli.ts", import.meta.url).pathname });
			return { content: [{ type: "text", text: result.message }], details: result, isError: !result.ok };
		},
	});

	pi.registerCommand("memory-curator-enable", {
		description: "Enable external daily memory curator service",
		handler: async (args, ctx) => {
			const schedule = args.trim() || undefined;
			const result = enableCuratorService({ memoryDir: MEMORY_DIR, cliPath: new URL("./src/cli.ts", import.meta.url).pathname, schedule });
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
		},
	});

	pi.registerCommand("memory-curator-disable", {
		description: "Disable external daily memory curator service",
		handler: async (_args, ctx) => {
			const result = disableCuratorService({ memoryDir: MEMORY_DIR, cliPath: new URL("./src/cli.ts", import.meta.url).pathname });
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
		},
	});

	pi.registerCommand("memory-curator-status", {
		description: "Show external daily memory curator service status",
		handler: async (_args, ctx) => {
			const result = getCuratorServiceStatus({ memoryDir: MEMORY_DIR, cliPath: new URL("./src/cli.ts", import.meta.url).pathname });
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
		},
	});

	// --- memory_search tool ---
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search across all memory files (MEMORY.md, SCRATCHPAD.md, daily logs).\n" +
			"Modes:\n" +
			"- 'keyword' (default, ~30ms): Fast BM25 search. Best for specific terms, dates, names, #tags, [[links]].\n" +
			"- 'semantic' (~2s): Meaning-based search. Finds related concepts even with different wording.\n" +
			"- 'deep' (~10s): Hybrid search with reranking. Use when other modes don't find what you need.\n" +
			"If semantic/deep warns about missing embeddings, run `qmd embed` once and retry.\n" +
			"If the first search doesn't find what you need, try rephrasing or switching modes. " +
			"Keyword mode is best for specific terms; semantic mode finds related concepts even with different wording.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			mode: Type.Optional(
				StringEnum(["keyword", "semantic", "deep"] as const, {
					description: "Search mode. Default: 'keyword'.",
				}),
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!qmdAvailable) {
				// Re-check on demand in case qmd was installed after session start.
				qmdAvailable = await detectQmd();
			}

			if (!qmdAvailable) {
				return {
					content: [
						{
							type: "text",
							text: qmdInstallInstructions(),
						},
					],
					isError: true,
					details: {},
				};
			}

			let hasCollection = await checkCollection("pi-memory");
			if (!hasCollection) {
				const created = await setupQmdCollection();
				if (created) {
					hasCollection = true;
				}
			}
			if (!hasCollection) {
				return {
					content: [
						{
							type: "text",
							text: "Could not set up qmd pi-memory collection. Check that qmd is working and the memory directory exists.",
						},
					],
					isError: true,
					details: {},
				};
			}

			const mode = params.mode ?? "keyword";
			const limit = params.limit ?? 5;

			try {
				const { results, stderr } = await runQmdSearch(mode, params.query, limit);
				const needsEmbed = /need embeddings/i.test(stderr ?? "");

				if (results.length === 0) {
					if (needsEmbed && (mode === "semantic" || mode === "deep")) {
						return {
							content: [
								{
									type: "text",
									text: [
										`No results found for "${params.query}" (mode: ${mode}).`,
										"",
										"qmd reports missing vector embeddings for one or more documents.",
										"Run this once, then retry:",
										"  qmd embed",
									].join("\n"),
								},
							],
							details: { mode, query: params.query, count: 0, needsEmbed: true },
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `No results found for "${params.query}" (mode: ${mode}).`,
							},
						],
						details: { mode, query: params.query, count: 0, needsEmbed },
					};
				}

				const formatted = results
					.map((r, i) => {
						const parts: string[] = [`### Result ${i + 1}`];
						const filePath = getQmdResultPath(r);
						if (filePath) parts.push(`**File:** ${filePath}`);
						if (r.score != null) parts.push(`**Score:** ${r.score}`);
						const text = getQmdResultText(r);
						if (text) parts.push(`\n${text}`);
						return parts.join("\n");
					})
					.join("\n\n---\n\n");

				return {
					content: [{ type: "text", text: formatted }],
					details: { mode, query: params.query, count: results.length, needsEmbed },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `memory_search error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: {},
				};
			}
		},
	});
}
