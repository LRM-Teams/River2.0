import { parseEntry } from "../curator-core/metadata.ts";

export type PendingReviewCounts = {
	memory: number;
	skill: number;
	incoming: number;
	total: number;
};

export type PendingReviewItem = {
	id: string;
	kind: string;
	status: string;
	confidence?: string;
	target?: string;
	summary: string;
};

const ENTRY_DELIMITER = "\n§\n";

export function countPendingReviewItems(reviewText: string): PendingReviewCounts {
	const items = listPendingReviewItems(reviewText);
	return {
		memory: items.filter((item) => item.kind === "memory_promotion").length,
		skill: items.filter((item) => item.kind === "skill_promotion").length,
		incoming: items.filter((item) => item.kind.startsWith("incoming_")).length,
		total: items.length,
	};
}

export function listPendingReviewItems(reviewText: string, options: { type?: "memory" | "skill"; limit?: number } = {}): PendingReviewItem[] {
	const limit = Math.max(0, options.limit ?? 20);
	const entries = reviewText.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
	const items: PendingReviewItem[] = [];
	for (const entry of entries) {
		try {
			const parsed = parseEntry(entry);
			if (parsed.metadata.type !== "review" || parsed.metadata.status !== "proposed") continue;
			const kind = parsed.metadata.kind || "review";
			if (options.type === "memory" && kind !== "memory_promotion") continue;
			if (options.type === "skill" && kind !== "skill_promotion") continue;
			items.push({
				id: parsed.metadata.id || "",
				kind,
				status: parsed.metadata.status || "",
				confidence: parsed.metadata.confidence,
				target: parsed.metadata.promotes_to,
				summary: summarizeReviewBody(parsed.body),
			});
		} catch {
			// Malformed review entries should never break startup hints or review commands.
		}
	}
	return limit > 0 ? items.slice(0, limit) : [];
}

export function formatPendingReviewSummary(counts: PendingReviewCounts): string {
	if (counts.total === 0) return "No pending memory/skill proposals.";
	return [
		`Curator completed: ${counts.memory} memory proposal(s) pending, ${counts.skill} skill proposal(s) pending.`,
		"Next: run /memory-review, or approve with memory_learning_approve id=<proposal-id>, reject with memory_learning_reject id=<proposal-id>.",
	].join("\n");
}

export function formatPendingReviewList(items: PendingReviewItem[], counts: PendingReviewCounts): string {
	if (items.length === 0) return "No pending memory/skill proposals.";
	const lines = [`Memory review: ${counts.memory} memory / ${counts.skill} skill proposals pending.`];
	for (const item of items) {
		const confidence = item.confidence ? ` confidence=${item.confidence}` : "";
		const target = item.target ? ` target=${item.target}` : "";
		lines.push(`- ${item.id || "<missing-id>"}: ${item.kind}${confidence}${target}`);
		if (item.summary) lines.push(`  ${item.summary}`);
	}
	lines.push("Approve with /memory-review approve <id>, reject with /memory-review reject <id>, or inspect with /memory-review show <id>.");
	return lines.join("\n");
}

function summarizeReviewBody(body: string): string {
	const line = body.split("\n").map((candidate) => candidate.trim()).find(Boolean) || "";
	return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}
