import { currentMonth, parseEntry, renderEntry, todayUtc } from "./metadata.ts";
import type { MemoryPatch } from "./patch.ts";
import type { MemoryTarget } from "../curator-store/types.ts";

export type CuratorPolicy = {
	markTodayEvents?: boolean;
	reviewExpiredTemporary?: boolean;
};

export const DEFAULT_CURATOR_POLICY: Required<CuratorPolicy> = {
	markTodayEvents: true,
	reviewExpiredTemporary: true,
};

export function createLifecyclePatches(target: MemoryTarget, rawEntries: string[], now: Date, policy: CuratorPolicy = {}): MemoryPatch[] {
	const resolvedPolicy = { ...DEFAULT_CURATOR_POLICY, ...policy };
	const patches: MemoryPatch[] = [];
	const today = todayUtc(now);
	const month = currentMonth(now);

	for (const raw of rawEntries) {
		const parsed = parseEntry(raw);
		if (!parsed.hasMetadata) continue;

		if (parsed.metadata.type === "event") {
			const date = parsed.metadata.date;
			const status = parsed.metadata.status;
			if (date && date < today && (status === "planned" || status === "today")) {
				const next = parseEntry(raw);
				next.metadata.status = "past";
				next.body = rewritePastEventBody(next.body);
				patches.push({ target, operation: "replace", oldText: raw, newText: renderEntry(next), reason: "event date passed", confidence: "high" });
				continue;
			}
			if (resolvedPolicy.markTodayEvents && date === today && status === "planned") {
				const next = parseEntry(raw);
				next.metadata.status = "today";
				patches.push({ target, operation: "replace", oldText: raw, newText: renderEntry(next), reason: "event date is today", confidence: "high" });
				continue;
			}
		}

		if (parsed.metadata.type === "temporary" && resolvedPolicy.reviewExpiredTemporary && parsed.metadata.date && parsed.metadata.date < today) {
			patches.push({
				target: "review",
				operation: "append_review",
				newText: `[type:review source:${target} reason:expired-temporary]\nTemporary memory may be stale: ${raw}`,
				reason: "temporary memory date passed",
				confidence: "high",
			});
		}

		if (parsed.metadata.type === "quota") {
			const reset = parsed.metadata.reset;
			const resetReached = reset ? Date.parse(reset) <= now.getTime() : false;
			if ((parsed.metadata.month && parsed.metadata.month !== month) || (parsed.metadata.status === "exhausted" && resetReached)) {
				const next = parseEntry(raw);
				next.metadata.month = month;
				next.metadata.status = "active";
				next.metadata.used = "0";
				const provider = next.metadata.provider || "provider";
				next.body = `${provider} search quota is active for ${month}.`;
				patches.push({ target, operation: "replace", oldText: raw, newText: renderEntry(next), reason: "quota reset date reached", confidence: "high" });
			}
		}
	}

	return patches;
}

function rewritePastEventBody(body: string): string {
	const rewritten = body
		.replace(/\bUser is planning\b/i, "User had")
		.replace(/\bUser plans\b/i, "User had planned")
		.replace(/\bUser planned\b/i, "User had planned");
	return /completion status unknown/i.test(rewritten) ? rewritten : `${rewritten} Completion status unknown.`;
}
