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

import { type ExecFileOptions, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
	parseReviewCandidate,
	upsertReviewCandidate,
	type ReviewCandidateInput,
} from "./src/learning/candidates.ts";
import { applyReviewLifecycle, approveMemoryPromotion, proposeMemoryPromotions, rejectReviewItem } from "./src/learning/memory.ts";
import { generateShareCandidatesFromReview } from "./src/governance/share-candidates.ts";
import { compactProcessedReviewEntries } from "./src/learning/review-compact.ts";
import { countPendingReviewItems, formatPendingReviewList, formatPendingReviewSummary, listPendingReviewItems } from "./src/learning/review-summary.ts";
import { defaultRegistryPath, markCurrentRootDirty, scanDirtyRoots } from "./src/manager/local-curator-manager.ts";
import { approvePendingSkillDrafts, approveSkillDraft, listSkillDraftProposals, proposeSkillDrafts } from "./src/learning/skills.ts";
import { disableMemorySkill, enableMemorySkill, formatEnabledSkillsForPrompt, formatSkillList, listMemorySkills } from "./src/skills/lifecycle.ts";
import { generateProfiles } from "./src/profile/generator.ts";
import { syncPull, syncUpload } from "./src/sync/connector.ts";
import { appendFeedbackEvent, buildFeedbackEvent } from "./src/sync/feedback.ts";
import { detectSensitivity } from "./src/sync/sensitivity.ts";
import { FileMemoryStore } from "./src/curator-store/file-store.ts";
import {
	ensureAgentRoot,
	resolveAgentRoot,
	resolveAgentRoots,
	resolveFeedbackDir,
	resolveInboxDir,
	resolveMemoryRoot,
	resolveProfileDir,
	resolveSharedCacheDir,
	resolveSkillDraftRoot,
	resolveSyncQueueDir,
	type PiAgentEnv,
} from "./src/paths/resolve-roots.ts";
import {
	disableCuratorManagerService,
	disableCuratorService,
	enableCuratorManagerService,
	enableCuratorService,
	getCuratorManagerServiceStatus,
	getCuratorServiceStatus,
} from "./src/service-controller.ts";


// ---------------------------------------------------------------------------
// Paths (mutable for testing via _setBaseDir / _resetBaseDir)
// ---------------------------------------------------------------------------

type MemoryEnv = PiAgentEnv & { [key: string]: string | undefined };

export function resolveMemoryDir(env: MemoryEnv = process.env): string {
	return resolveMemoryRoot(env);
}

export function resolveSkillDraftDir(env: MemoryEnv = process.env): string {
	return resolveSkillDraftRoot(env);
}

export {
	ensureAgentRoot,
	resolveAgentRoot,
	resolveFeedbackDir,
	resolveInboxDir,
	resolveMemoryRoot,
	resolveProfileDir,
	resolveSharedCacheDir,
	resolveSkillDraftRoot,
	resolveSyncQueueDir,
};

const INITIAL_ROOTS = resolveAgentRoots();
let AGENT_ROOT = INITIAL_ROOTS.agentRoot;
let MEMORY_DIR = INITIAL_ROOTS.memoryDir;
let MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
let USER_FILE = path.join(MEMORY_DIR, "USER.md");
let STATE_FILE = path.join(MEMORY_DIR, "STATE.md");
let REVIEW_FILE = path.join(MEMORY_DIR, "REVIEW.md");
let SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
let DAILY_DIR = path.join(MEMORY_DIR, "daily");
let SKILL_DRAFTS_DIR = INITIAL_ROOTS.skillDraftsDir;

const SESSION_HISTORY_BACKFILL_STATE = ".session-history-backfill-state.json";

function setResolvedDirs(memoryDir: string, skillDraftsDir: string, agentRoot?: string) {
	AGENT_ROOT = agentRoot;
	MEMORY_DIR = memoryDir;
	MEMORY_FILE = path.join(memoryDir, "MEMORY.md");
	USER_FILE = path.join(memoryDir, "USER.md");
	STATE_FILE = path.join(memoryDir, "STATE.md");
	REVIEW_FILE = path.join(memoryDir, "REVIEW.md");
	SCRATCHPAD_FILE = path.join(memoryDir, "SCRATCHPAD.md");
	DAILY_DIR = path.join(memoryDir, "daily");
	SKILL_DRAFTS_DIR = skillDraftsDir;
}

/** Override base directory (for testing). */
export function _setBaseDir(baseDir: string, skillDraftsDir = path.join(path.dirname(baseDir), "skill-drafts")) {
	setResolvedDirs(baseDir, skillDraftsDir);
}

function refreshResolvedDirsFromEnv() {
	const roots = resolveAgentRoots();
	setResolvedDirs(roots.memoryDir, roots.skillDraftsDir, roots.agentRoot);
}

/** Reset to default paths (for testing). */
export function _resetBaseDir() {
	refreshResolvedDirsFromEnv();
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function ensureDirs() {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.mkdirSync(DAILY_DIR, { recursive: true });
	fs.mkdirSync(path.join(MEMORY_DIR, "audit"), { recursive: true });
	fs.mkdirSync(SKILL_DRAFTS_DIR, { recursive: true });
	for (const filePath of [MEMORY_FILE, USER_FILE, STATE_FILE, REVIEW_FILE]) {
		if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf-8");
	}
	if (!fs.existsSync(SCRATCHPAD_FILE)) fs.writeFileSync(SCRATCHPAD_FILE, "# Scratchpad\n", "utf-8");
	if (AGENT_ROOT) ensureAgentRoot(process.env);
}

function markDirtyBestEffort(): void {
	if (!AGENT_ROOT) return;
	try {
		markCurrentRootDirty(process.env);
	} catch {
		// Dirty marking must not break memory writes or session shutdown.
	}
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

export type ExitSummaryReason = "ctrl+d" | "slash-quit" | "session-end";
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

export function getMemorySkillDraftsMode(env: MemoryEnv = process.env): "off" | "propose" | "auto-draft" {
	const value = (env.PI_MEMORY_SKILL_DRAFTS || "auto-draft").toLowerCase();
	if (value === "off") return "off";
	if (value === "propose" || value === "review") return "propose";
	return "auto-draft";
}

function getMemorySkillSeenThreshold(env: MemoryEnv = process.env): number {
	const value = Number.parseInt(env.PI_MEMORY_SKILL_SEEN_THRESHOLD || "2", 10);
	return Number.isFinite(value) && value > 0 ? value : 2;
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

function envFlag(env: MemoryEnv, name: string): boolean | undefined {
	const value = env[name]?.trim().toLowerCase();
	if (!value) return undefined;
	if (["1", "true", "yes", "on"].includes(value)) return true;
	if (["0", "false", "no", "off"].includes(value)) return false;
	return undefined;
}

export function getMemoryAutoSyncPullOnStart(env: MemoryEnv = process.env): boolean {
	return envFlag(env, "PI_MEMORY_AUTO_SYNC_PULL_ON_START")
		?? envFlag(env, "PI_MEMORY_AUTO_SYNC_PULL")
		?? envFlag(env, "PI_MEMORY_AUTO_SYNC")
		?? false;
}

export function getMemoryAutoSyncUploadOnShutdown(env: MemoryEnv = process.env): boolean {
	return envFlag(env, "PI_MEMORY_AUTO_SYNC_UPLOAD_ON_SHUTDOWN")
		?? envFlag(env, "PI_MEMORY_AUTO_SYNC_UPLOAD")
		?? envFlag(env, "PI_MEMORY_AUTO_SYNC")
		?? false;
}

function getMemoryAutoSyncPullLimit(env: MemoryEnv = process.env): number {
	const value = Number.parseInt(env.PI_MEMORY_AUTO_SYNC_PULL_LIMIT || "20", 10);
	return Number.isFinite(value) && value > 0 ? value : 20;
}

async function runAutoSyncPullBestEffort(): Promise<void> {
	if (!getMemoryAutoSyncPullOnStart()) return;
	try {
		await syncPull(process.env, getMemoryAutoSyncPullLimit());
	} catch {
		// Automatic sync is a Multica/local-agent convenience; never block startup.
	}
}

async function runAutoSyncUploadBestEffort(): Promise<void> {
	if (!getMemoryAutoSyncUploadOnShutdown()) return;
	try {
		await syncUpload();
	} catch {
		// Automatic sync is a Multica/local-agent convenience; never block shutdown.
	}
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
		"For skill candidates, prefer reusable methods with clear trigger signals, steps, validation signals, and stop/avoid conditions.",
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

function getSessionFile(ctx: ExtensionContext): string | undefined {
	const sessionManager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
		getSessionFile?: () => string | undefined;
	};
	return typeof sessionManager?.getSessionFile === "function" ? sessionManager.getSessionFile() : undefined;
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

export function parseLearningExtractorResponse(raw: string, source = "session_shutdown"): ReviewCandidateInput[] {
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
			? record.targetHints.filter((hint): hint is NonNullable<ReviewCandidateInput["targetHints"]>[number] => typeof hint === "string" && REVIEW_TARGET_HINTS.includes(hint as NonNullable<ReviewCandidateInput["targetHints"]>[number]))
			: undefined;
		candidates.push({
			kind,
			confidence,
			signature,
			summary: typeof record.summary === "string" ? record.summary.trim() : undefined,
			targetHints,
			evidence: typeof record.evidence === "string" ? record.evidence.trim() : undefined,
			source,
		});
	}
	return candidates;
}


type ToolCallInfo = {
	name: string;
	arguments?: Record<string, unknown>;
};

type StructuredFailure = {
	summary: string;
	signature: string;
	toolName: string;
};

function countReviewCandidates(reviewText: string): { total: number; skill: number } {
	const entries = reviewText.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
	let total = 0;
	let skill = 0;
	for (const entry of entries) {
		const candidate = parseReviewCandidate(entry);
		if (!candidate) continue;
		total += 1;
		if (candidate.kind === "skill_candidate" || candidate.targetHints.includes("skill")) skill += 1;
	}
	return { total, skill };
}

function collectToolCalls(branch: SessionEntry[]): Map<string, ToolCallInfo> {
	const calls = new Map<string, ToolCallInfo>();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message as Message;
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			const candidate = part as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
			if (candidate.type !== "toolCall" || !candidate.id || !candidate.name) continue;
			calls.set(candidate.id, { name: candidate.name, arguments: candidate.arguments });
		}
	}
	return calls;
}

function getToolArgumentText(args: Record<string, unknown> | undefined, key: string): string {
	const value = args?.[key];
	return typeof value === "string" ? value : "";
}

function summarizeToolText(text: string): string {
	const line = text
		.split("\n")
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate && !candidate.startsWith("{"));
	return previewMessageText(line || text);
}

function isFailureToolResult(message: Message, text: string): boolean {
	if (message.role !== "toolResult") return false;
	if (message.isError) return true;
	return /\b(Command exited with code [1-9]|failed|failure|error|exception|traceback|diagnostics?:\s*(?!ok)|ERR_[A-Z0-9_]+)\b/i.test(text);
}

function isEditOrActionTool(toolName: string, args: Record<string, unknown> | undefined): boolean {
	if (["edit", "write", "memory_write", "memory_edit", "lsp"].includes(toolName)) return true;
	if (toolName !== "bash") return false;
	const command = getToolArgumentText(args, "command");
	return /\b(apply_patch|python3?|node|perl|sed\s+-i|mv\s+|cp\s+|npm\s+install|pnpm\s+|bun\s+|cat\s+>|tee\s+)\b/.test(command);
}

function isValidationToolSuccess(toolName: string, args: Record<string, unknown> | undefined, text: string): boolean {
	if (toolName === "lsp") return /diagnostics.*ok|\bOK\b/i.test(text);
	if (toolName !== "bash") return false;
	const command = getToolArgumentText(args, "command");
	return /\b(test|typecheck|lint|check|tsc|build|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\b|npm\s+run|pnpm\s+(test|run|--filter))\b/i.test(command);
}

function toolLabel(toolName: string, args: Record<string, unknown> | undefined): string {
	if (toolName === "bash") return previewMessageText(getToolArgumentText(args, "command")) || "bash";
	if (toolName === "lsp") return `lsp ${getToolArgumentText(args, "action")}`.trim();
	return toolName;
}

export function extractStructuredToolEvidenceCandidates(branch: SessionEntry[], source = "tool_evidence"): ReviewCandidateInput[] {
	const calls = collectToolCalls(branch);
	const candidates: ReviewCandidateInput[] = [];
	const emitted = new Set<string>();
	let failure: StructuredFailure | null = null;
	let actionAfterFailure = false;
	let actionLabel = "";

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message as Message;
		if (message.role !== "toolResult") continue;
		const info = calls.get(message.toolCallId);
		const toolName = message.toolName || info?.name || "tool";
		const args = info?.arguments;
		const text = getMessageText(message);

		if (isFailureToolResult(message, text)) {
			const summary = summarizeToolText(text);
			failure = {
				summary,
				signature: `${toolName} ${summary}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 96) || toolName,
				toolName,
			};
			actionAfterFailure = false;
			actionLabel = "";
			continue;
		}

		if (!failure) continue;
		if (isEditOrActionTool(toolName, args)) {
			actionAfterFailure = true;
			actionLabel = toolLabel(toolName, args);
			continue;
		}
		if (!actionAfterFailure || !isValidationToolSuccess(toolName, args, text)) continue;

		const validation = toolLabel(toolName, args);
		const signature = `fix ${failure.signature} validated by ${validation}`.slice(0, 120);
		if (!emitted.has(signature)) {
			emitted.add(signature);
			candidates.push({
				kind: "skill_candidate",
				confidence: "high",
				signature,
				summary: `Use a failure -> edit/action -> validation loop: inspect ${failure.toolName} failure, apply ${actionLabel || "the smallest relevant fix"}, then rerun ${validation}.`,
				targetHints: ["skill"],
				evidence: `Failure: ${failure.summary}; action: ${actionLabel || "edit/action"}; validation: ${validation}.`,
				source,
			});
		}
		failure = null;
		actionAfterFailure = false;
		actionLabel = "";
		if (candidates.length >= 3) break;
	}

	return candidates;
}

async function writeLearningCandidates(candidates: ReviewCandidateInput[]): Promise<number> {
	if (candidates.length === 0) return 0;
	let written = 0;
	const store = new FileMemoryStore(MEMORY_DIR);
	for (const candidate of candidates) {
		const result = await upsertReviewCandidate(store, candidate);
		if (result.changed) written += 1;
	}
	return written;
}

async function extractLearningCandidatesFromBranch(
	branch: SessionEntry[],
	ctx: ExtensionContext | undefined,
	options: { source: string; includeModel?: boolean; includeStructured?: boolean } = { source: "session_shutdown" },
): Promise<ReviewCandidateInput[]> {
	const candidates: ReviewCandidateInput[] = [];
	if (options.includeStructured !== false) {
		candidates.push(...extractStructuredToolEvidenceCandidates(branch, options.source));
	}
	if (options.includeModel !== false && ctx?.model) {
		const apiKey = await resolveExitSummaryApiKey(ctx);
		const conversation = serializeSessionConversation(branch);
		if (apiKey && conversation.hasMessages && conversation.text.trim()) {
			const truncated = truncateText(conversation.text.trim(), LEARNING_EXTRACTOR_MAX_CHARS, "end");
			const messages: Message[] = [{
				role: "user",
				content: [{ type: "text", text: buildLearningExtractorPrompt(truncated.text, truncated.truncated, conversation.text.trim().length) }],
				timestamp: Date.now(),
			}];
			try {
				const response = await complete(ctx.model, { systemPrompt: LEARNING_EXTRACTOR_SYSTEM_PROMPT, messages }, { apiKey, reasoningEffort: "low" });
				const raw = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
				candidates.push(...parseLearningExtractorResponse(raw, options.source));
			} catch {
				// Historical learning is best-effort and must not block the manual pass.
			}
		}
	}
	return candidates;
}

async function runSessionLearningExtractor(
	ctx: ExtensionContext,
	options: { source?: string; includeModel?: boolean; includeStructured?: boolean } = {},
): Promise<number> {
	if (getMemoryLearningMode() === "off") return 0;
	const branch = getSessionBranch(ctx);
	if (!branch) return 0;
	const source = options.source || "session_shutdown";
	const candidates = await extractLearningCandidatesFromBranch(branch, ctx, { ...options, source });
	return writeLearningCandidates(candidates);
}

type SessionHistoryBackfillState = {
	processed: Record<string, { mtimeMs: number; size: number; processedAt: string; candidates: number }>;
};

export type SessionHistoryBackfillResult = {
	scanned: number;
	processed: number;
	skipped: number;
	candidates: number;
	errors: string[];
	files: string[];
	curatorSummary?: string;
	dryRun: boolean;
};

function readJsonFile<T>(filePath: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

function readSessionHistoryBackfillState(): SessionHistoryBackfillState {
	return readJsonFile(path.join(MEMORY_DIR, SESSION_HISTORY_BACKFILL_STATE), { processed: {} });
}

function writeSessionHistoryBackfillState(state: SessionHistoryBackfillState): void {
	fs.writeFileSync(path.join(MEMORY_DIR, SESSION_HISTORY_BACKFILL_STATE), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function sessionDateFromPath(filePath: string): string | undefined {
	const match = path.basename(filePath).match(/(\d{4}-\d{2}-\d{2})/);
	return match?.[1];
}

function normalizeSessionHistoryRoots(ctx?: ExtensionContext, pathsInput: string[] = []): string[] {
	const roots = new Set<string>();
	for (const input of pathsInput) {
		if (input.trim()) roots.add(path.resolve(ctx?.cwd || process.cwd(), input));
	}
	if (roots.size > 0) return [...roots];
	const sessionFile = ctx ? getSessionFile(ctx) : undefined;
	if (sessionFile) roots.add(path.dirname(sessionFile));
	if (ctx?.cwd) roots.add(path.join(ctx.cwd, ".pi", "agent", "sessions"));
	const home = process.env.HOME;
	if (home) roots.add(path.join(home, ".pi", "agent", "sessions"));
	return [...roots];
}

function collectSessionJsonlFiles(roots: string[], options: { recursive?: boolean; since?: string; limit?: number; exclude?: string }): string[] {
	const files: string[] = [];
	const seen = new Set<string>();
	const exclude = options.exclude ? path.resolve(options.exclude) : undefined;
	const visit = (candidate: string) => {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(candidate);
		} catch {
			return;
		}
		if (stat.isDirectory()) {
			let entries: string[];
			try {
				entries = fs.readdirSync(candidate);
			} catch {
				return;
			}
			for (const entry of entries) {
				const child = path.join(candidate, entry);
				if (options.recursive === false) {
					try {
						if (fs.statSync(child).isFile() && child.endsWith(".jsonl")) visit(child);
					} catch {
						// Ignore unreadable entries.
					}
				} else {
					visit(child);
				}
			}
			return;
		}
		if (!stat.isFile() || !candidate.endsWith(".jsonl")) return;
		const resolved = path.resolve(candidate);
		if (exclude && resolved === exclude) return;
		if (seen.has(resolved)) return;
		const date = sessionDateFromPath(resolved);
		if (options.since && date && date < options.since) return;
		seen.add(resolved);
		files.push(resolved);
	};
	for (const root of roots) visit(root);
	files.sort((a, b) => {
		try {
			return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
		} catch {
			return a.localeCompare(b);
		}
	});
	return typeof options.limit === "number" && options.limit > 0 ? files.slice(-options.limit) : files;
}

export function readSessionEntriesFromJsonl(filePath: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	const raw = fs.readFileSync(filePath, "utf-8");
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as SessionEntry;
			if ((parsed as { type?: string }).type === "message") entries.push(parsed);
		} catch {
			// Ignore malformed historical lines; valid messages still contribute.
		}
	}
	return entries;
}

export async function backfillSessionHistoryLearning(
	ctx?: ExtensionContext,
	options: {
		paths?: string[];
		limit?: number;
		since?: string;
		force?: boolean;
		dryRun?: boolean;
		includeModel?: boolean;
		includeStructured?: boolean;
		includeCurrent?: boolean;
		runCuratorAfter?: boolean;
	} = {},
): Promise<SessionHistoryBackfillResult> {
	ensureDirs();
	const roots = normalizeSessionHistoryRoots(ctx, options.paths);
	const currentFile = ctx && options.includeCurrent !== true ? getSessionFile(ctx) : undefined;
	const files = collectSessionJsonlFiles(roots, { recursive: true, since: options.since, limit: options.limit, exclude: currentFile });
	const state = readSessionHistoryBackfillState();
	const result: SessionHistoryBackfillResult = { scanned: files.length, processed: 0, skipped: 0, candidates: 0, errors: [], files: [], dryRun: Boolean(options.dryRun) };
	const candidatesToWrite: ReviewCandidateInput[] = [];

	for (const filePath of files) {
		try {
			const stat = fs.statSync(filePath);
			const previous = state.processed[filePath];
			if (!options.force && previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
				result.skipped += 1;
				continue;
			}
			const branch = readSessionEntriesFromJsonl(filePath);
			if (branch.length === 0) {
				result.skipped += 1;
				continue;
			}
			const source = `session_history_${sessionDateFromPath(filePath) || "unknown"}`;
			const candidates = await extractLearningCandidatesFromBranch(branch, ctx, {
				source,
				includeModel: Boolean(options.includeModel),
				includeStructured: options.includeStructured,
			});
			const datedCandidates = candidates.map((candidate) => ({
				...candidate,
				date: candidate.date || sessionDateFromPath(filePath),
				evidence: [candidate.evidence, `Session: ${path.basename(filePath)}`].filter(Boolean).join("; "),
			}));
			candidatesToWrite.push(...datedCandidates);
			result.candidates += datedCandidates.length;
			result.processed += 1;
			result.files.push(filePath);
			if (!options.dryRun) {
				state.processed[filePath] = { mtimeMs: stat.mtimeMs, size: stat.size, processedAt: new Date().toISOString(), candidates: datedCandidates.length };
			}
		} catch (error) {
			result.errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (!options.dryRun && candidatesToWrite.length > 0) {
		result.candidates = await writeLearningCandidates(candidatesToWrite);
		snapshotDirty = true;
		markDirtyBestEffort();
		if (options.runCuratorAfter !== false && getMemorySkillDraftsMode() !== "off") {
			result.curatorSummary = await runCurator("session_history_backfill");
		}
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
	}
	if (!options.dryRun) writeSessionHistoryBackfillState(state);
	return result;
}

function formatSessionHistoryBackfillResult(result: SessionHistoryBackfillResult): string {
	const lines = [
		`Session history backfill: scanned ${result.scanned}, processed ${result.processed}, skipped ${result.skipped}, candidate change(s) ${result.candidates}${result.dryRun ? " (dry-run)" : ""}.`,
	];
	if (result.curatorSummary) lines.push(result.curatorSummary);
	if (result.errors.length > 0) {
		lines.push("", `Errors (${result.errors.length}):`, ...result.errors.slice(0, 10).map((error) => `- ${error}`));
	}
	return lines.join("\n");
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
	const content = message.content;
	if (typeof content === "string") return content.trim();
	return content
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
		.map((entry) => entry.message as Message)
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


function buildSharedCacheContext(prompt: string): string {
	const roots = resolveAgentRoots(process.env);
	if (!roots.sharedCacheDir && !roots.agentRoot) return "";
	const promptText = prompt.toLowerCase();
	const units: Array<{ id: string; unitType: "memory" | "skill"; title: string; text: string; score: number }> = [];
	const memoryDir = roots.sharedCacheDir ? path.join(roots.sharedCacheDir, "memory") : undefined;
	if (memoryDir && fs.existsSync(memoryDir)) {
		for (const name of fs.readdirSync(memoryDir).filter((file) => file.endsWith(".json"))) {
			try {
				const delivery = JSON.parse(fs.readFileSync(path.join(memoryDir, name), "utf-8")) as { shared_unit_id?: string; id?: string; content?: string; tags?: string[]; score?: number };
				const content = String(delivery.content || "").trim();
				if (!content || detectSensitivity(content) === "secret") continue;
				const id = delivery.shared_unit_id || delivery.id || name.replace(/\.json$/, "");
				units.push({ id, unitType: "memory", title: `Shared memory ${id}`, text: content, score: sharedUnitScore(promptText, content, delivery.tags, delivery.score) });
			} catch {
				// Ignore malformed shared-cache entries.
			}
		}
	}
	const generatedDir = roots.agentRoot ? path.join(roots.agentRoot, "skills", "generated") : undefined;
	if (generatedDir && fs.existsSync(generatedDir)) {
		for (const name of fs.readdirSync(generatedDir)) {
			const skillPath = path.join(generatedDir, name, "SKILL.md");
			if (!fs.existsSync(skillPath)) continue;
			const content = fs.readFileSync(skillPath, "utf-8").trim();
			if (!content || detectSensitivity(content) === "secret") continue;
			const score = sharedUnitScore(promptText, content, undefined, undefined);
			if (score > 0) units.push({ id: name, unitType: "skill", title: `Generated shared skill ${name}`, text: content.split("\n").slice(0, 20).join("\n"), score });
		}
	}
	const selected = units.filter((unit) => unit.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
	if (selected.length === 0) return "";
	for (const unit of selected) {
		try {
			appendFeedbackEvent(buildFeedbackEvent({ shared_unit_id: unit.id, unit_type: unit.unitType, event: "injected", outcome: "neutral" }), process.env);
		} catch {
			// Feedback must not block context injection.
		}
	}
	return selected.map((unit) => `### ${unit.title}\n${unit.text}`).join("\n\n---\n\n");
}

function sharedUnitScore(promptText: string, content: string, tags: string[] | undefined, remoteScore: number | undefined): number {
	let score = typeof remoteScore === "number" ? remoteScore : 0;
	for (const tag of tags || []) {
		if (promptText.includes(tag.toLowerCase())) score += 2;
	}
	const words = new Set(promptText.split(/[^a-zA-Z0-9_\u4e00-\u9fff]+/).filter((word) => word.length >= 3));
	for (const word of words) {
		if (content.toLowerCase().includes(word)) score += 1;
	}
	return score;
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

// --- Background (detached) shutdown ---
// The final-exit workload (exit summary + learning extractor + curator + qmd)
// can take 30-60s because it issues additional LLM calls. In non-interactive
// (print/json) modes nobody is watching a UI, so we offload the whole workload
// to a detached child process and let the main pi process exit immediately.
// The worker reads the session JSONL from disk, reconstructs a minimal ctx,
// and runs the same workload. Memory still lands in the right agent dir because
// the worker inherits PI_AGENT_ROOT / PI_MEMORY_DIR from process.env.

export type BackgroundShutdownMode = "auto" | "on" | "off";

export function getBackgroundShutdownMode(env: MemoryEnv = process.env): BackgroundShutdownMode {
	const raw = (env.PI_MEMORY_BACKGROUND_SHUTDOWN ?? "auto").toLowerCase();
	if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return "off";
	if (raw === "on" || raw === "1" || raw === "true" || raw === "yes" || raw === "always") return "on";
	return "auto";
}

/**
 * Whether the final-exit workload should run in a detached background process.
 *
 * NOTE: the detached worker path is currently **disabled by default** because the
 * standalone worker process cannot reliably resolve its peer dependencies
 * (`@earendil-works/pi-ai` moved `complete` to a `/compat` subpath in 0.80.x,
 * and node_modules tree resolution differs from the in-process loader). The
 * Multica daemon instead achieves the same latency win with an early-complete
 * on `turn_end` (see multica server/pkg/agent/pi.go), so the main pi process
 * can still exit immediately while the synchronous shutdown workload runs to
 * completion inside it.
 *
 * Set `PI_MEMORY_BACKGROUND_SHUTDOWN=on` to opt back into the detached worker
 * (e.g. once pi-memory migrates to the compat import). `off` keeps the legacy
 * synchronous behavior. `auto` is treated as `off` until the worker is fixed.
 */
export function shouldRunBackgroundShutdown(ctx: ExtensionContext, env: MemoryEnv = process.env): boolean {
	const mode = getBackgroundShutdownMode(env);
	if (mode === "off") return false;
	if (mode === "on") return true;
	// auto: disabled until worker dependency resolution is fixed (see note above).
	return false;
}

/** Resolve the path to the detached shutdown CLI script packaged alongside. */
function backgroundShutdownCliPath(): string {
	return new URL("./scripts/background-shutdown-cli.ts", import.meta.url).pathname;
}

/**
 * Resolve a TypeScript-capable runtime for the detached worker. Node 22 cannot
 * type-strip files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
 * and the worker lives under node_modules, so prefer `bun` (handles TS anywhere)
 * then `tsx` (bundled with pi-suite), falling back to `node` last (the worker
 * will fail and the handler falls back to the synchronous workload).
 * Returns [execPath, preArgs[]].
 */
function resolveBackgroundShutdownRuntime(): [string, string[]] {
	const candidates: Array<[string, string[]]> = [];
	// 1. bun (anywhere on PATH).
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const bunPath = path.join(dir, "bun");
		try {
			if (fs.statSync(bunPath).isFile() && !bunPath.includes("node_modules")) {
				candidates.push([bunPath, []]);
				break;
			}
		} catch {}
	}
	// 2. tsx loader (bundled under the agent npm .bin), run via node.
	try {
		const tsxPath = new URL("../../../../.bin/tsx", import.meta.url).pathname;
		if (fs.existsSync(tsxPath)) candidates.push([process.execPath, [tsxPath]]);
	} catch {}
	// 3. node last resort.
	candidates.push([process.execPath, []]);
	return candidates[0];
}

/**
 * Spawn a detached background process that performs the full final-exit
 * memory workload (exit summary, learning extractor, curator, qmd, sync upload).
 * Returns immediately after spawning; the main pi process is free to exit.
 *
 * A JSON payload (session file, session id, reason, serialized model) is written
 * to `<memory>/audit/` and its path passed to the worker. The API key is handed
 * over via a private env var so it never lands on disk.
 */
async function spawnBackgroundShutdown(ctx: ExtensionContext, reason: ExitSummaryReason): Promise<void> {
	const sessionFile = getSessionFile(ctx);
	if (!sessionFile || !fs.existsSync(sessionFile)) {
		throw new Error("session file unavailable; cannot offload shutdown");
	}
	const sessionId = ctx.sessionManager.getSessionId();
	let apiKey: string | undefined;
	try {
		apiKey = await resolveExitSummaryApiKey(ctx);
	} catch {
		apiKey = undefined;
	}
	let modelJson: string | null = null;
	if (ctx.model) {
		try {
			modelJson = JSON.stringify(ctx.model);
		} catch {
			modelJson = null;
		}
	}
	const payload = {
		sessionFile,
		sessionId,
		reason: reason ?? "session-end",
		model: modelJson,
	};

	ensureDirs();
	const auditDir = path.join(MEMORY_DIR, "audit");
	fs.mkdirSync(auditDir, { recursive: true });
	const payloadPath = path.join(auditDir, `bg-shutdown-${Date.now()}-${process.pid}.json`);
	fs.writeFileSync(payloadPath, JSON.stringify(payload), "utf-8");

	const cliScript = backgroundShutdownCliPath();
	const [runtimeExec, runtimePreArgs] = resolveBackgroundShutdownRuntime();
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (apiKey) env.__PI_MEMORY_BG_KEY = apiKey;

	const child = spawn(runtimeExec, [...runtimePreArgs, cliScript, "--payload", payloadPath], {
		detached: true,
		stdio: "ignore",
		env,
	});
	child.unref();
}

/**
 * The final-exit memory workload: exit summary, learning extractor, curator,
 * qmd update, and best-effort sync upload. Extracted so it can run either
 * inline (synchronous shutdown) or inside a detached background worker that
 * reconstructs a minimal ctx from the session JSONL on disk.
 */
export async function runFinalExitWorkload(ctx: ExtensionContext, reason: ExitSummaryReason | null): Promise<void> {
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
				const newCandidates = await runSessionLearningExtractor(ctx);
				if (getMemorySkillDraftsMode() === "auto-draft") await runCurator("session_learning");
				if (ctx.hasUI && process.env.PI_MEMORY_REVIEW_SESSION_SUMMARY !== "0") {
					const reviewText = readFileSafe(REVIEW_FILE) ?? "";
					const pending = countPendingReviewItems(reviewText);
					const candidates = countReviewCandidates(reviewText);
					const skills = listMemorySkills(process.env);
					ctx.ui.notify(`Memory learning today: ${newCandidates} new candidate(s), ${candidates.skill} skill candidate(s), ${pending.memory} memory proposal(s), ${pending.skill} skill proposal(s), ${skills.drafts.length} draft(s).`, "info");
				}
				await ensureQmdAvailableForUpdate();
				await runQmdUpdateNow();
			}
		}
	} finally {
		await runAutoSyncUploadBestEffort();
	}
}

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

function qmdCollectionName(): string {
	const scoped = process.env.PI_MEMORY_DIR || process.env.PI_AGENT_ROOT || (process.env.MULTICA_WORKSPACE_ID && process.env.MULTICA_AGENT_ID);
	if (!scoped) return "pi-memory";
	return `pi-memory-${createHash("sha1").update(MEMORY_DIR).digest("hex").slice(0, 12)}`;
}

export function qmdInstallInstructions(): string {
	return [
		"memory_search requires qmd.",
		"",
		"Install qmd (requires Bun):",
		`  bun install -g ${QMD_REPO_URL}`,
		"  # ensure ~/.bun/bin is in your PATH",
		"",
		"Then set up the collection (one-time):",
		`  qmd collection add ${MEMORY_DIR} --name ${qmdCollectionName()}`,
		"  qmd embed",
	].join("\n");
}

export function qmdCollectionInstructions(): string {
	return [
		"qmd collection for the current memory root is not configured.",
		"",
		"Set up the collection (one-time):",
		`  qmd collection add ${MEMORY_DIR} --name ${qmdCollectionName()}`,
		"  qmd embed",
	].join("\n");
}

/** Auto-create the pi-memory collection and path contexts in qmd. */
export async function setupQmdCollection(): Promise<boolean> {
	try {
		await new Promise<void>((resolve, reject) => {
			execFileFn("qmd", ["collection", "add", MEMORY_DIR, "--name", qmdCollectionName()], { timeout: 10_000 }, (err) =>
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
				execFileFn("qmd", ["context", "add", ctxPath, desc, "-c", qmdCollectionName()], { timeout: 10_000 }, (err) =>
					err ? reject(err) : resolve(),
				);
			});
		} catch {
			// Ignore — context may already exist
		}
	}
	// Seed the cache so checkCollection(qmdCollectionName()) doesn't redundantly re-run
	// setupQmdCollection during the short negative-cache window.
	qmdCollectionStatusCache.set(qmdCollectionName(), { checkedAt: Date.now(), exists: true });
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
	markDirtyBestEffort();
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	if (updateTimer) clearTimeout(updateTimer);
	updateTimer = setTimeout(() => {
		updateTimer = null;
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => {});
	}, 500);
}

async function runQmdUpdateNow() {
	markDirtyBestEffort();
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
		const hasCollection = await checkCollection(qmdCollectionName());
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
	const args = [subcommand, "--json", "-c", qmdCollectionName(), "-n", String(limit), query];

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
	const skillDraftMode = getMemorySkillDraftsMode();
	const skillResult = skillDraftMode === "off" ? { created: 0, proposals: [] } : await proposeSkillDrafts(store, { draftsDir: SKILL_DRAFTS_DIR, seenThreshold: getMemorySkillSeenThreshold() });
	let autoApprovedMemory = 0;
	let autoApprovedSkills = 0;
	if (getMemoryAutoApproveMemory()) {
		for (const id of memoryResult.proposalIds) {
			await approveMemoryPromotion(store, id);
			autoApprovedMemory += 1;
		}
	}
	if (skillDraftMode === "auto-draft" || getMemoryAutoApproveSkillDrafts()) {
		autoApprovedSkills = (await approvePendingSkillDrafts(store, skillResult.proposals.map((proposal) => proposal.id))).length;
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
	const baseSummary = notes.length > 0 ? `${result.summary}; ${notes.join("; ")}` : result.summary;
	let shareCandidateNote = "";
	if (AGENT_ROOT) {
		try {
			const shareResult = await generateShareCandidatesFromReview(store, process.env);
			generateProfiles(process.env);
			if (shareResult.created > 0 || shareResult.errors.length > 0) {
				shareCandidateNote = `\nGenerated ${shareResult.created} share candidate(s)${shareResult.errors.length ? `; ${shareResult.errors.length} error(s)` : ""}.`;
			}
		} catch {
			// Share candidate/profile generation is best-effort and must not block local curation.
		}
	}
	const pending = countPendingReviewItems(readFileSafe(REVIEW_FILE) ?? "");
	return `${baseSummary}${shareCandidateNote}\n${formatPendingReviewSummary(pending)}`;
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
		refreshResolvedDirsFromEnv();
		ensureDirs();
		await runAutoSyncPullBestEffort();
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
			if (process.env.PI_MEMORY_REVIEW_STARTUP_HINT !== "0") {
				const reviewText = readFileSafe(REVIEW_FILE) ?? "";
				const pending = countPendingReviewItems(reviewText);
				const candidates = countReviewCandidates(reviewText);
				const skills = listMemorySkills(process.env);
				const hasWork = pending.total > 0 || candidates.total > 0 || skills.drafts.length > 0 || skills.generated.length > 0 || skills.enabled.length > 0;
				if (hasWork) {
					ctx.ui.notify(`Memory review: ${candidates.total} candidate(s) (${candidates.skill} skill), ${pending.memory} memory proposal(s), ${pending.skill} skill proposal(s), ${skills.drafts.length} draft(s), ${skills.generated.length} generated, ${skills.enabled.length} enabled. Run /memory-review or /memory-skill.`, "info");
				}
			}
		}

		qmdAvailable = await detectQmd();
		if (!qmdAvailable) {
			if (ctx.hasUI) {
				ctx.ui.notify(qmdInstallInstructions(), "info");
			}
			refreshMemorySnapshot("session_start");
			return;
		}

		const hasCollection = await checkCollection(qmdCollectionName());
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
					await runSessionLearningExtractor(ctx, { source: `transition_${shutdownReason}`, includeModel: false, includeStructured: true });
					if (getMemorySkillDraftsMode() === "auto-draft") await runCurator(`transition_${shutdownReason}`);
				}
			} finally {
				await runAutoSyncUploadBestEffort();
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

		// Background (detached) shutdown: offload the full final-exit workload to a
		// child process so the main pi process can exit immediately. Only active in
		// non-interactive (print/json) modes by default (PI_MEMORY_BACKGROUND_SHUTDOWN).
		if (shouldRunBackgroundShutdown(ctx)) {
			let offloaded = false;
			try {
				await spawnBackgroundShutdown(ctx, reason);
				offloaded = true;
			} catch (err) {
				// Fall through to the synchronous workload below so the session still
				// gets its summary/learning even if the worker spawn fails.
				try {
					const auditDir = path.join(MEMORY_DIR, "audit");
					fs.mkdirSync(auditDir, { recursive: true });
					fs.appendFileSync(path.join(auditDir, "background-shutdown-errors.jsonl"), JSON.stringify({ ts: nowTimestamp(), error: err instanceof Error ? err.message : String(err) }) + "\n", "utf-8");
				} catch {
					// Best-effort logging only.
				}
			}
			if (offloaded) {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = null;
				}
				return;
			}
		}

		try {
			await runFinalExitWorkload(ctx, reason);
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

		const sharedContext = buildSharedCacheContext(event.prompt ?? "");
		if (sharedContext) {
			memoryContext = memoryContext
				? `${memoryContext}\n\n---\n\n## Matched Shared Cache\n\n${sharedContext}`
				: `# Memory\n\n## Matched Shared Cache\n\n${sharedContext}`;
		}

		const enabledSkillsContext = formatEnabledSkillsForPrompt(process.env);
		if (enabledSkillsContext) {
			memoryContext = memoryContext
				? `${memoryContext}\n\n---\n\n## Enabled Agent Skills\n\n${enabledSkillsContext}`
				: `# Memory\n\n## Enabled Agent Skills\n\n${enabledSkillsContext}`;
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

	pi.registerTool({
		name: "memory_skill_list",
		label: "Memory Skill List",
		description: "List current-agent draft, generated, and enabled memory-managed skills.",
		parameters: Type.Object({}),
		async execute(): Promise<any> {
			try {
				const skills = listMemorySkills(process.env);
				return { content: [{ type: "text", text: formatSkillList(skills) }], details: skills };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "memory_skill_enable",
		label: "Memory Skill Enable",
		description: "Enable a current-agent skill from drafts or generated deliveries. Use source like draft:<slug> or generated:<id>.",
		parameters: Type.Object({
			source: Type.String({ description: "Skill source, e.g. draft:my-skill or generated:unit_123" }),
			force: Type.Optional(Type.Boolean({ description: "Replace an existing enabled skill with the same name" })),
		}),
		async execute(_toolCallId, params): Promise<any> {
			try {
				const result = enableMemorySkill(params.source, { force: params.force, env: process.env });
				return { content: [{ type: "text", text: `Enabled skill ${result.enabled.name}: ${result.path}` }], details: result };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "memory_skill_disable",
		label: "Memory Skill Disable",
		description: "Disable an enabled current-agent memory-managed skill by id or skill name. Draft/generated sources are kept.",
		parameters: Type.Object({
			id: Type.String({ description: "Enabled skill id or frontmatter name" }),
		}),
		async execute(_toolCallId, params): Promise<any> {
			try {
				const result = disableMemorySkill(params.id, process.env);
				return { content: [{ type: "text", text: `Disabled skill ${result.id}: ${result.path}` }], details: result };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
			}
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


	pi.registerTool({
		name: "memory_session_history_backfill",
		label: "Memory Session History Backfill",
		description: "Manually scan historical Pi session JSONL files that may have missed shutdown review/curator processing, extract review candidates, then run memory/skill proposal curation.",
		parameters: Type.Object({
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional session JSONL files or directories. Defaults to current project/global Pi session roots." })),
			limit: Type.Optional(Type.Number({ description: "Maximum newest session files to scan after filtering." })),
			since: Type.Optional(Type.String({ description: "Only scan sessions dated on/after YYYY-MM-DD when the filename contains a date." })),
			force: Type.Optional(Type.Boolean({ description: "Reprocess files already recorded in .session-history-backfill-state.json." })),
			dryRun: Type.Optional(Type.Boolean({ description: "Scan and extract without writing REVIEW.md or state." })),
			includeModel: Type.Optional(Type.Boolean({ description: "Also run the model-based extractor when an API key is available. Default false to avoid token usage." })),
			includeCurrent: Type.Optional(Type.Boolean({ description: "Include the current live session file. Default false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = await backfillSessionHistoryLearning(ctx, {
					paths: params.paths,
					limit: params.limit,
					since: params.since,
					force: params.force,
					dryRun: params.dryRun,
					includeModel: params.includeModel,
					includeCurrent: params.includeCurrent,
				});
				return { content: [{ type: "text", text: formatSessionHistoryBackfillResult(result) }], details: result };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
			}
		},
	});

	pi.registerCommand("memory-session-history-backfill", {
		description: "Scan historical session JSONL files for missed memory/skill review candidates",
		handler: async (args, ctx) => {
			try {
				const tokens = args.trim().split(/\s+/).filter(Boolean);
				const paths: string[] = [];
				let limit: number | undefined;
				let since: string | undefined;
				let force = false;
				let dryRun = false;
				let includeModel = false;
				let includeCurrent = false;
				for (let i = 0; i < tokens.length; i++) {
					const token = tokens[i];
					if (token === "--limit") limit = Number.parseInt(tokens[++i] || "", 10);
					else if (token === "--since") since = tokens[++i];
					else if (token === "--force") force = true;
					else if (token === "--dry-run") dryRun = true;
					else if (token === "--include-model") includeModel = true;
					else if (token === "--include-current") includeCurrent = true;
					else paths.push(token);
				}
				const result = await backfillSessionHistoryLearning(ctx, { paths, limit: Number.isFinite(limit) ? limit : undefined, since, force, dryRun, includeModel, includeCurrent });
				ctx.ui.notify(formatSessionHistoryBackfillResult(result), result.errors.length ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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

	pi.registerTool({
		name: "memory_feedback",
		label: "Memory Feedback",
		description: "Record injected/used/ignored/success/failure/conflict feedback for a downflowed shared memory or skill.",
		parameters: Type.Object({
			shared_unit_id: Type.String({ description: "Shared unit id" }),
			unit_type: StringEnum(["memory", "skill"] as const, { description: "Shared unit type" }),
			event: StringEnum(["injected", "used", "ignored", "success", "failure", "conflict"] as const, { description: "Feedback event" }),
			outcome: Type.Optional(StringEnum(["success", "failure", "neutral"] as const, { description: "Optional outcome" })),
			task_type: Type.Optional(Type.String({ description: "Optional task type" })),
		}),
		async execute(_toolCallId, params): Promise<any> {
			try {
				const event = buildFeedbackEvent({
					shared_unit_id: params.shared_unit_id,
					unit_type: params.unit_type as "memory" | "skill",
					event: params.event as "injected" | "used" | "ignored" | "success" | "failure" | "conflict",
					outcome: params.outcome as "success" | "failure" | "neutral" | undefined,
					task_type: params.task_type,
				});
				const filePath = appendFeedbackEvent(event);
				markDirtyBestEffort();
				return { content: [{ type: "text", text: `Recorded feedback: ${filePath}` }], details: { path: filePath, event } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "memory_curator_manager_mark_dirty",
		label: "Memory Curator Manager Mark Dirty",
		description: "Register and mark the current Multica agent root dirty for the singleton Local Curator Manager.",
		parameters: Type.Object({}),
		async execute(): Promise<any> {
			try {
				const record = markCurrentRootDirty(process.env);
				return { content: [{ type: "text", text: `Marked dirty: ${record.agent_root}` }], details: record };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "memory_curator_manager_scan",
		label: "Memory Curator Manager Scan",
		description: "Process dirty roots from the singleton Local Curator Manager registry with per-root locks.",
		parameters: Type.Object({
			registry: Type.Optional(Type.String({ description: "Optional registry path" })),
		}),
		async execute(_toolCallId, params): Promise<any> {
			try {
				const registryPath = params.registry || defaultRegistryPath();
				const result = await scanDirtyRoots(registryPath);
				return { content: [{ type: "text", text: `Local curator manager processed ${result.processed} root(s), ${result.failures} failure(s).` }], details: { registryPath, ...result } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "memory_curator_manager_enable",
		label: "Memory Curator Manager Enable",
		description: "Enable the singleton Local Curator Manager service. Default schedule checks dirty roots every 6 hours.",
		parameters: Type.Object({
			registry: Type.Optional(Type.String({ description: "Optional registry path" })),
			schedule: Type.Optional(Type.String({ description: "Cron or systemd calendar schedule. Default: 0 */6 * * *." })),
		}),
		execute(_toolCallId, params): any {
			const registryPath = params.registry || defaultRegistryPath();
			const result = enableCuratorManagerService({ registryPath, cliPath: new URL("./src/cli.ts", import.meta.url).pathname, schedule: params.schedule });
			return { content: [{ type: "text", text: result.message }], details: result, isError: !result.ok };
		},
	});

	pi.registerTool({
		name: "memory_curator_manager_disable",
		label: "Memory Curator Manager Disable",
		description: "Disable the singleton Local Curator Manager service.",
		parameters: Type.Object({
			registry: Type.Optional(Type.String({ description: "Optional registry path" })),
		}),
		execute(_toolCallId, params): any {
			const registryPath = params.registry || defaultRegistryPath();
			const result = disableCuratorManagerService({ registryPath, cliPath: new URL("./src/cli.ts", import.meta.url).pathname });
			return { content: [{ type: "text", text: result.message }], details: result, isError: !result.ok };
		},
	});

	pi.registerTool({
		name: "memory_curator_manager_status",
		label: "Memory Curator Manager Status",
		description: "Show the singleton Local Curator Manager service status.",
		parameters: Type.Object({
			registry: Type.Optional(Type.String({ description: "Optional registry path" })),
		}),
		execute(_toolCallId, params): any {
			const registryPath = params.registry || defaultRegistryPath();
			const result = getCuratorManagerServiceStatus({ registryPath, cliPath: new URL("./src/cli.ts", import.meta.url).pathname });
			return { content: [{ type: "text", text: result.message }], details: result, isError: !result.ok };
		},
	});

	pi.registerTool({
		name: "memory_sync_upload",
		label: "Memory Sync Upload",
		description: "Upload governed local memory/skill candidates, profiles, and feedback to Multica when PI_MEMORY_REMOTE_URL/TOKEN are configured.",
		parameters: Type.Object({}),
		async execute() {
			try {
				const result = await syncUpload();
				return { content: [{ type: "text", text: result.skipped || `Uploaded ${result.candidates} candidate(s), ${result.profiles} profile file(s), ${result.feedback} feedback event(s).` }], details: result };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { ok: false, skipped: message, candidates: 0, feedback: 0, profiles: 0 }, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "memory_sync_pull",
		label: "Memory Sync Pull",
		description: "Pull Multica evolution deliveries for the current agent and write only inbox/shared-cache/generated-skill files.",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Maximum deliveries to pull. Default: 20." })),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await syncPull(process.env, params.limit ?? 20);
				return { content: [{ type: "text", text: result.skipped || `Pulled ${result.received} delivery(s), rejected ${result.rejected}.` }], details: result };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: message }], details: { ok: false, skipped: message, received: 0, rejected: 0, written: [] }, isError: true };
			}
		},
	});

	pi.registerCommand("memory-curator-manager-scan", {
		description: "Run the singleton Local Curator Manager over dirty roots",
		handler: async (args, ctx) => {
			try {
				const registryPath = args.trim() || defaultRegistryPath();
				const result = await scanDirtyRoots(registryPath);
				ctx.ui.notify(`Local curator manager processed ${result.processed} root(s), ${result.failures} failure(s).`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("memory-curator-manager-enable", {
		description: "Enable the singleton Local Curator Manager service",
		handler: async (args, ctx) => {
			const result = enableCuratorManagerService({ registryPath: defaultRegistryPath(), cliPath: new URL("./src/cli.ts", import.meta.url).pathname, schedule: args.trim() || undefined });
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
		},
	});

	pi.registerCommand("memory-curator-manager-disable", {
		description: "Disable the singleton Local Curator Manager service",
		handler: async (_args, ctx) => {
			const result = disableCuratorManagerService({ registryPath: defaultRegistryPath(), cliPath: new URL("./src/cli.ts", import.meta.url).pathname });
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
		},
	});

	pi.registerCommand("memory-curator-manager-status", {
		description: "Show the singleton Local Curator Manager service status",
		handler: async (_args, ctx) => {
			const result = getCuratorManagerServiceStatus({ registryPath: defaultRegistryPath(), cliPath: new URL("./src/cli.ts", import.meta.url).pathname });
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
		},
	});

	pi.registerCommand("memory-skill", {
		description: "List, enable, or disable current-agent memory-managed skills",
		handler: async (args, ctx) => {
			try {
				const [command, value, ...rest] = args.trim().split(/\s+/).filter(Boolean);
				if (!command || command === "list") {
					ctx.ui.notify(formatSkillList(listMemorySkills(process.env)), "info");
					return;
				}
				if (command === "enable") {
					if (!value) throw new Error("Usage: /memory-skill enable <draft:slug|generated:id> [--force]");
					const result = enableMemorySkill(value, { force: rest.includes("--force"), env: process.env });
					ctx.ui.notify(`Enabled skill ${result.enabled.name}: ${result.path}`, "info");
					return;
				}
				if (command === "disable") {
					if (!value) throw new Error("Usage: /memory-skill disable <id-or-name>");
					const result = disableMemorySkill(value, process.env);
					ctx.ui.notify(`Disabled skill ${result.id}: ${result.path}`, "info");
					return;
				}
				throw new Error("Usage: /memory-skill [list|enable|disable]");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("memory-sync-upload", {
		description: "Upload governed memory candidates, profiles, and feedback to Multica",
		handler: async (_args, ctx) => {
			try {
				const result = await syncUpload();
				ctx.ui.notify(result.skipped || `Uploaded ${result.candidates} candidate(s), ${result.profiles} profile file(s), ${result.feedback} feedback event(s).`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("memory-sync-pull", {
		description: "Pull current-agent Multica memory/skill deliveries into local cache",
		handler: async (args, ctx) => {
			try {
				const limit = Number.parseInt(args.trim() || "20", 10);
				const result = await syncPull(process.env, Number.isFinite(limit) ? limit : 20);
				ctx.ui.notify(result.skipped || `Pulled ${result.received} delivery(s), rejected ${result.rejected}.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("memory-review", {
		description: "List, show, approve, reject, or archive pending memory/skill review proposals",
		handler: async (args, ctx) => {
			try {
				const tokens = args.trim().split(/\s+/).filter(Boolean);
				const command = tokens[0];
				const store = new FileMemoryStore(MEMORY_DIR);
				if (command === "approve") {
					const id = tokens[1];
					if (!id) throw new Error("Usage: /memory-review approve <id>");
					try {
						const memoryResult = await approveMemoryPromotion(store, id);
						snapshotDirty = true;
						await ensureQmdAvailableForUpdate();
						scheduleQmdUpdate();
						ctx.ui.notify(`Approved ${memoryResult.proposalId}. Wrote ${memoryResult.target}.`, "info");
						return;
					} catch {
						const skillResult = await approveSkillDraft(store, id);
						snapshotDirty = true;
						await ensureQmdAvailableForUpdate();
						scheduleQmdUpdate();
						ctx.ui.notify(`Approved ${skillResult.proposalId}. Created disabled skill draft: ${skillResult.path}`, "info");
						return;
					}
				}
				if (command === "reject" || command === "archive") {
					const id = tokens[1];
					if (!id) throw new Error(`Usage: /memory-review ${command} <id>`);
					await rejectReviewItem(store, id, command === "archive" ? "archived" : "rejected");
					snapshotDirty = true;
					await ensureQmdAvailableForUpdate();
					scheduleQmdUpdate();
					ctx.ui.notify(`Marked ${id} as ${command === "archive" ? "archived" : "rejected"}.`, "info");
					return;
				}
				if (command === "compact") {
					const reviewText = readFileSafe(REVIEW_FILE) ?? "";
					const compacted = compactProcessedReviewEntries(reviewText, { compactDays: Number.parseInt(process.env.PI_MEMORY_REVIEW_COMPACT_DAYS || "30", 10) });
					if (compacted.removed > 0) {
						fs.writeFileSync(REVIEW_FILE, compacted.activeEntries.join(ENTRY_DELIMITER), "utf-8");
					markDirtyBestEffort();
						fs.mkdirSync(path.join(MEMORY_DIR, "audit"), { recursive: true });
						fs.appendFileSync(path.join(MEMORY_DIR, "audit", "curator.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), action: "review_compact", removed: compacted.removed })}\n`, "utf-8");
					}
					ctx.ui.notify(`Compacted REVIEW.md: removed ${compacted.removed} processed item(s).`, "info");
					return;
				}
				if (command === "show") {
					const id = tokens[1];
					if (!id) throw new Error("Usage: /memory-review show <id>");
					const entry = (await store.readEntries("review")).find((candidate) => parseStructuredEntry(candidate).metadata.id === id);
					ctx.ui.notify(entry || `No review entry found for id '${id}'.`, entry ? "info" : "error");
					return;
				}
				const typeFlagIndex = tokens.indexOf("--type");
				const type = typeFlagIndex >= 0 ? tokens[typeFlagIndex + 1] : undefined;
				const limitFlagIndex = tokens.indexOf("--limit");
				const limit = limitFlagIndex >= 0 ? Number.parseInt(tokens[limitFlagIndex + 1] || "20", 10) : 20;
				const reviewText = readFileSafe(REVIEW_FILE) ?? "";
				const counts = countPendingReviewItems(reviewText);
				const items = listPendingReviewItems(reviewText, {
					type: type === "memory" || type === "skill" ? type : undefined,
					limit: Number.isFinite(limit) ? limit : 20,
				});
				ctx.ui.notify(formatPendingReviewList(items, counts), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
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

			let hasCollection = await checkCollection(qmdCollectionName());
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
