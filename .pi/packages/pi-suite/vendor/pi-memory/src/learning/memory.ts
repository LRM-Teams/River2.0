import { parseEntry, renderEntry } from "../curator-core/metadata.ts";
import type { MemoryStore, MemoryTarget } from "../curator-store/types.ts";
import { parseReviewCandidate, type ParsedReviewCandidate } from "./candidates.ts";

export type MemoryPromotionResult = {
	created: number;
	proposalIds: string[];
};

export type MemoryApprovalResult = {
	proposalId: string;
	target: MemoryTarget;
	content: string;
};

export type ReviewLifecycleResult = {
	changed: number;
};

export async function proposeMemoryPromotions(memoryStore: MemoryStore, seenThreshold = 2): Promise<MemoryPromotionResult> {
	const entries = await memoryStore.readEntries("review");
	const existingProposalSources = new Set(
		entries
			.map((entry) => parseEntry(entry).metadata)
			.filter((metadata) => metadata.type === "review" && (metadata.kind === "memory_promotion" || metadata.kind === "memory_merge"))
			.flatMap((metadata) => (metadata.source_candidate_ids || "").split(",").map((id) => id.trim()).filter(Boolean)),
	);
	const proposals = entries
		.map(parseReviewCandidate)
		.filter((candidate): candidate is ParsedReviewCandidate => candidate !== null)
		.filter((candidate) => isMemoryCandidateReady(candidate, seenThreshold) && !existingProposalSources.has(candidate.id))
		.map(renderMemoryProposalEntry);
	if (proposals.length === 0) return { created: 0, proposalIds: [] };
	await memoryStore.writeEntries("review", [...entries, ...proposals]);
	return { created: proposals.length, proposalIds: proposals.map((entry) => parseEntry(entry).metadata.id || "").filter(Boolean) };
}

export async function approveMemoryPromotion(memoryStore: MemoryStore, proposalId: string): Promise<MemoryApprovalResult> {
	const entries = await memoryStore.readEntries("review");
	const index = entries.findIndex((entry) => parseEntry(entry).metadata.id === proposalId);
	if (index < 0) throw new Error(`No review proposal found for id '${proposalId}'.`);
	const parsed = parseEntry(entries[index]);
	if (parsed.metadata.type !== "review" || parsed.metadata.kind !== "memory_promotion" || parsed.metadata.status !== "proposed") {
		throw new Error(`Review entry '${proposalId}' is not a proposed memory promotion.`);
	}
	const target = normalizePromotionTarget(parsed.metadata.promotes_to);
	const content = bodyBlock(parsed.body, "Memory") || bodyField(parsed.body, "Proposal");
	if (!content) throw new Error(`Memory proposal '${proposalId}' has no memory content.`);
	const targetEntries = await memoryStore.readEntries(target);
	if (!targetEntries.includes(content)) await memoryStore.writeEntries(target, [...targetEntries, content]);
	const approved = renderEntry({
		...parsed,
		metadata: { ...parsed.metadata, status: "approved", approved_at: new Date().toISOString() },
		body: `${parsed.body.trim()}\nApplied: ${target}`,
	});
	const updated = [...entries];
	updated[index] = approved;
	await memoryStore.writeEntries("review", updated);
	return { proposalId, target, content };
}

export async function rejectReviewItem(memoryStore: MemoryStore, id: string, status: "rejected" | "archived" = "rejected"): Promise<void> {
	const entries = await memoryStore.readEntries("review");
	const index = entries.findIndex((entry) => parseEntry(entry).metadata.id === id);
	if (index < 0) throw new Error(`No review entry found for id '${id}'.`);
	const parsed = parseEntry(entries[index]);
	if (parsed.metadata.type !== "review") throw new Error(`Entry '${id}' is not a review entry.`);
	const updated = [...entries];
	updated[index] = renderEntry({ ...parsed, metadata: { ...parsed.metadata, status, reviewed_at: new Date().toISOString() } });
	await memoryStore.writeEntries("review", updated);
}

export async function applyReviewLifecycle(memoryStore: MemoryStore, now = new Date(), staleDays = 30, archiveDays = 90): Promise<ReviewLifecycleResult> {
	const entries = await memoryStore.readEntries("review");
	let changed = 0;
	const updated = entries.map((entry) => {
		const parsed = parseEntry(entry);
		if (parsed.metadata.type !== "review" || parsed.metadata.status !== "candidate") return entry;
		const lastSeen = parsed.metadata.last_seen || parsed.metadata.first_seen;
		if (!lastSeen) return entry;
		const ageDays = Math.floor((now.getTime() - Date.parse(`${lastSeen}T00:00:00.000Z`)) / 86_400_000);
		if (!Number.isFinite(ageDays) || ageDays < staleDays) return entry;
		const nextStatus = ageDays >= archiveDays && parsed.metadata.confidence === "low" ? "archived" : "needs_review";
		changed += 1;
		return renderEntry({ ...parsed, metadata: { ...parsed.metadata, status: nextStatus, reviewed_at: now.toISOString() } });
	});
	if (changed > 0) await memoryStore.writeEntries("review", updated);
	return { changed };
}

function isMemoryCandidateReady(candidate: ParsedReviewCandidate, threshold: number): boolean {
	if (!["preference", "project_fact", "bug_fix"].includes(candidate.kind) && !candidate.targetHints.includes("memory")) return false;
	return candidate.seen >= threshold || candidate.confidence === "high";
}

function renderMemoryProposalEntry(candidate: ParsedReviewCandidate): string {
	const target = candidate.kind === "preference" ? "user" : "memory";
	const content = formatMemoryContent(candidate);
	return renderEntry({
		metadata: {
			type: "review",
			status: "proposed",
			id: `mem_${candidate.id.slice(4)}`,
			kind: "memory_promotion",
			confidence: candidate.confidence,
			source_candidate_ids: candidate.id,
			promotes_to: target,
		},
		body: [`Proposal: Promote reviewed candidate to ${target}.`, `Memory: ${content}`].join("\n"),
		raw: "",
		hasMetadata: true,
	});
}

function formatMemoryContent(candidate: ParsedReviewCandidate): string {
	const type = candidate.kind === "preference" ? "preference" : "fact";
	const summary = candidate.summary || candidate.signature;
	return `[type:${type}]\n${summary}`;
}

function normalizePromotionTarget(value: string | undefined): MemoryTarget {
	if (value === "user" || value === "state" || value === "review") return value;
	return "memory";
}

function bodyField(body: string, field: string): string | null {
	const prefix = `${field}:`;
	const line = body.split("\n").find((candidate) => candidate.startsWith(prefix));
	return line?.slice(prefix.length).trim() || null;
}

function bodyBlock(body: string, field: string): string | null {
	const prefix = `${field}:`;
	const lines = body.split("\n");
	const start = lines.findIndex((line) => line.startsWith(prefix));
	if (start < 0) return null;
	const first = lines[start].slice(prefix.length).trim();
	const rest: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^[A-Z][A-Za-z ]+:/.test(line)) break;
		rest.push(line);
	}
	return [first, ...rest].join("\n").trim() || null;
}
