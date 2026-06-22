import { parseEntry } from "../curator-core/metadata.ts";
import { ENTRY_DELIMITER } from "../curator-store/types.ts";

export type ReviewCompactResult = {
	activeEntries: string[];
	removedEntries: string[];
	removed: number;
};

const COMPACT_STATUSES = new Set(["approved", "rejected", "archived", "merged"]);

export function compactProcessedReviewEntries(reviewText: string, options: { now?: Date; compactDays?: number } = {}): ReviewCompactResult {
	const now = options.now ?? new Date();
	const compactDays = options.compactDays ?? 30;
	const activeEntries: string[] = [];
	const removedEntries: string[] = [];
	for (const entry of reviewText.split(ENTRY_DELIMITER).map((item) => item.trim()).filter(Boolean)) {
		if (shouldCompactEntry(entry, now, compactDays)) removedEntries.push(entry);
		else activeEntries.push(entry);
	}
	return { activeEntries, removedEntries, removed: removedEntries.length };
}

function shouldCompactEntry(entry: string, now: Date, compactDays: number): boolean {
	try {
		const parsed = parseEntry(entry);
		if (parsed.metadata.type !== "review" || !COMPACT_STATUSES.has(parsed.metadata.status || "")) return false;
		const timestamp = parsed.metadata.approved_at || parsed.metadata.reviewed_at || parsed.metadata.merged_at || parsed.metadata.last_seen;
		if (!timestamp) return compactDays <= 0;
		const ageMs = now.getTime() - Date.parse(timestamp.includes("T") ? timestamp : `${timestamp}T00:00:00.000Z`);
		if (!Number.isFinite(ageMs)) return false;
		return ageMs >= compactDays * 86_400_000;
	} catch {
		return false;
	}
}
