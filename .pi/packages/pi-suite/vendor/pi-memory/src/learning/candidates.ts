import { createHash } from "node:crypto";
import { parseEntry, renderEntry, type ParsedEntry } from "../curator-core/metadata.ts";
import type { MemoryStore } from "../curator-store/types.ts";

export const REVIEW_CANDIDATE_KINDS = ["bug_fix", "skill_candidate", "preference", "project_fact"] as const;
export const REVIEW_PROMOTION_KINDS = ["memory_promotion", "memory_merge", "skill_promotion"] as const;
export const REVIEW_STATUSES = [
	"candidate",
	"merged",
	"proposed",
	"approved",
	"rejected",
	"archived",
	"stale",
	"needs_review",
] as const;
export const REVIEW_CONFIDENCES = ["low", "medium", "high"] as const;
export const REVIEW_TARGET_HINTS = ["memory", "skill"] as const;

export type ReviewCandidateKind = (typeof REVIEW_CANDIDATE_KINDS)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type ReviewConfidence = (typeof REVIEW_CONFIDENCES)[number];
export type ReviewTargetHint = (typeof REVIEW_TARGET_HINTS)[number];

export type ReviewCandidateInput = {
	kind: ReviewCandidateKind;
	confidence: ReviewConfidence;
	signature: string;
	summary?: string;
	source?: string;
	targetHints?: ReviewTargetHint[];
	evidence?: string;
	date?: string;
};

export type ParsedReviewCandidate = {
	entry: ParsedEntry;
	id: string;
	kind: ReviewCandidateKind;
	status: ReviewStatus;
	confidence: ReviewConfidence;
	seen: number;
	firstSeen: string;
	lastSeen: string;
	signature: string;
	summary?: string;
	evidence: string[];
	targetHints: ReviewTargetHint[];
	normalizedSignature: string;
};

export type UpsertReviewCandidateResult = {
	changed: boolean;
	merged: boolean;
	id: string;
	entry: string;
};

const CONFIDENCE_RANK: Record<ReviewConfidence, number> = {
	low: 0,
	medium: 1,
	high: 2,
};

export function todayUtc(now: Date): string {
	return now.toISOString().slice(0, 10);
}

export function normalizeCandidateSignature(kind: string, signature: string): string {
	return `${kind}:${signature.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ")}`;
}

export function createReviewCandidateId(kind: string, signature: string): string {
	const digest = createHash("sha256").update(normalizeCandidateSignature(kind, signature)).digest("hex").slice(0, 12);
	return `rev_${digest}`;
}

export function validateReviewCandidateInput(input: ReviewCandidateInput): string[] {
	const errors: string[] = [];
	if (!REVIEW_CANDIDATE_KINDS.includes(input.kind)) errors.push(`invalid kind '${input.kind}'`);
	if (!REVIEW_CONFIDENCES.includes(input.confidence)) errors.push(`invalid confidence '${input.confidence}'`);
	if (!input.signature.trim()) errors.push("signature is required");
	for (const hint of input.targetHints ?? []) {
		if (!REVIEW_TARGET_HINTS.includes(hint)) errors.push(`invalid target hint '${hint}'`);
	}
	return errors;
}

export function renderReviewCandidate(input: ReviewCandidateInput, now = new Date()): string {
	const errors = validateReviewCandidateInput(input);
	if (errors.length) throw new Error(`Invalid review candidate: ${errors.join("; ")}`);

	const signature = input.signature.trim();
	const date = input.date || todayUtc(now);
	const metadata: Record<string, string> = {
		type: "review",
		status: "candidate",
		id: createReviewCandidateId(input.kind, signature),
		kind: input.kind,
		confidence: input.confidence,
		seen: "1",
		first_seen: date,
		last_seen: date,
	};
	if (input.source?.trim()) metadata.source = input.source.trim().replace(/[\s\]]+/g, "-");
	if (input.targetHints?.length) metadata.target_hints = [...new Set(input.targetHints)].join(",");

	const body = [`Signature: ${signature}`];
	if (input.summary?.trim()) body.push(`Summary: ${input.summary.trim()}`);
	if (input.evidence?.trim()) body.push(`Evidence: ${input.evidence.trim()}`);
	return renderEntry({ metadata, body: body.join("\n"), raw: "", hasMetadata: true });
}

export function parseReviewCandidate(raw: string): ParsedReviewCandidate | null {
	const entry = parseEntry(raw);
	const metadata = entry.metadata;
	if (metadata.type !== "review" || metadata.status !== "candidate") return null;
	if (!metadata.id || !REVIEW_CANDIDATE_KINDS.includes(metadata.kind as ReviewCandidateKind)) return null;
	if (!REVIEW_STATUSES.includes(metadata.status as ReviewStatus)) return null;
	if (!REVIEW_CONFIDENCES.includes(metadata.confidence as ReviewConfidence)) return null;
	const signature = extractBodyField(entry.body, "Signature");
	if (!signature) return null;
	const seen = Number.parseInt(metadata.seen || "1", 10);
	const targetHints = (metadata.target_hints || "")
		.split(",")
		.map((hint) => hint.trim())
		.filter((hint): hint is ReviewTargetHint => REVIEW_TARGET_HINTS.includes(hint as ReviewTargetHint));
	return {
		entry,
		id: metadata.id,
		kind: metadata.kind as ReviewCandidateKind,
		status: metadata.status as ReviewStatus,
		confidence: metadata.confidence as ReviewConfidence,
		seen: Number.isFinite(seen) && seen > 0 ? seen : 1,
		firstSeen: metadata.first_seen || metadata.last_seen || todayUtc(new Date()),
		lastSeen: metadata.last_seen || metadata.first_seen || todayUtc(new Date()),
		signature,
		summary: extractBodyField(entry.body, "Summary") || undefined,
		evidence: extractBodyFields(entry.body, "Evidence"),
		targetHints,
		normalizedSignature: normalizeCandidateSignature(metadata.kind, signature),
	};
}

export async function upsertReviewCandidate(
	memoryStore: MemoryStore,
	input: ReviewCandidateInput,
	now = new Date(),
): Promise<UpsertReviewCandidateResult> {
	const newEntry = renderReviewCandidate(input, now);
	const newCandidate = parseReviewCandidate(newEntry);
	if (!newCandidate) throw new Error("Rendered review candidate could not be parsed.");

	const entries = await memoryStore.readEntries("review");
	const existingIndex = entries.findIndex((entry) => {
		const candidate = parseReviewCandidate(entry);
		return candidate?.normalizedSignature === newCandidate.normalizedSignature;
	});

	if (existingIndex < 0) {
		await memoryStore.writeEntries("review", [...entries, newEntry]);
		return { changed: true, merged: false, id: newCandidate.id, entry: newEntry };
	}

	const existing = parseReviewCandidate(entries[existingIndex]);
	if (!existing) throw new Error("Matched review candidate could not be parsed.");
	const updatedEntry = mergeReviewCandidate(existing, input, now);
	if (updatedEntry === entries[existingIndex]) return { changed: false, merged: true, id: existing.id, entry: updatedEntry };
	const updatedEntries = [...entries];
	updatedEntries[existingIndex] = updatedEntry;
	await memoryStore.writeEntries("review", updatedEntries);
	return { changed: true, merged: true, id: existing.id, entry: updatedEntry };
}

function mergeReviewCandidate(existing: ParsedReviewCandidate, input: ReviewCandidateInput, now: Date): string {
	const metadata = { ...existing.entry.metadata };
	metadata.seen = String(existing.seen + 1);
	metadata.last_seen = input.date || todayUtc(now);
	if (CONFIDENCE_RANK[input.confidence] > CONFIDENCE_RANK[existing.confidence]) metadata.confidence = input.confidence;
	if (input.targetHints?.length) {
		const current = (metadata.target_hints || "").split(",").map((hint) => hint.trim()).filter(Boolean);
		metadata.target_hints = [...new Set([...current, ...input.targetHints])].join(",");
	}

	let body = existing.entry.body;
	if (input.evidence?.trim() && !body.includes(input.evidence.trim())) {
		body = `${body.trim()}\nEvidence: ${input.evidence.trim()}`;
	}
	return renderEntry({ ...existing.entry, metadata, body });
}

export function extractBodyField(body: string, field: string): string | null {
	const prefix = `${field}:`;
	const line = body.split("\n").find((candidate) => candidate.startsWith(prefix));
	return line?.slice(prefix.length).trim() || null;
}

export function extractBodyFields(body: string, field: string): string[] {
	const prefix = `${field}:`;
	return body
		.split("\n")
		.filter((candidate) => candidate.startsWith(prefix))
		.map((candidate) => candidate.slice(prefix.length).trim())
		.filter(Boolean);
}
