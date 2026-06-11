import { auditEntryFromPatch, type AuditLog } from "./audit.ts";
import type { CuratorPolicy } from "./policy.ts";
import { createLifecyclePatches } from "./policy.ts";
import type { MemoryPatch } from "./patch.ts";
import { validateMemoryPatch } from "./patch.ts";
import { MEMORY_TARGETS, type MemoryStore, type MemoryTarget } from "../curator-store/types.ts";

export type RunMemoryCuratorOnceOptions = {
	memoryStore: MemoryStore;
	auditLog?: AuditLog;
	policy?: CuratorPolicy;
	now?: () => Date;
	dryRun?: boolean;
	reason?: string;
};

export type CuratorRunResult = {
	runId: string;
	changed: number;
	reviewed: number;
	deduped: number;
	patches: MemoryPatch[];
	summary: string;
	dryRun: boolean;
};

export async function runMemoryCuratorOnce(options: RunMemoryCuratorOnceOptions): Promise<CuratorRunResult> {
	const now = options.now?.() || new Date();
	const runId = now.toISOString();
	const entriesByTarget = new Map<MemoryTarget, string[]>();
	const patches: MemoryPatch[] = [];
	let deduped = 0;

	for (const target of MEMORY_TARGETS) {
		if (target === "review") continue;
		const entries = await options.memoryStore.readEntries(target);
		entriesByTarget.set(target, entries);
		const dedupedEntries = dedupeEntries(entries);
		if (dedupedEntries.length !== entries.length) {
			deduped += entries.length - dedupedEntries.length;
			patches.push({ target, operation: "dedupe", reason: "duplicate exact entries", confidence: "high" });
		}
		patches.push(...createLifecyclePatches(target, dedupedEntries, now, options.policy));
	}

	const errors = patches.flatMap((patch) => validateMemoryPatch(patch).map((error) => `${patch.operation}: ${error}`));
	if (errors.length) throw new Error(`Invalid curator patch: ${errors.join("; ")}`);

	if (!options.dryRun && patches.length > 0) {
		await applyPatches(options.memoryStore, entriesByTarget, patches);
		const reviewedAt = now.toISOString();
		for (const patch of patches) await options.auditLog?.write(auditEntryFromPatch(runId, patch, reviewedAt));
	}

	const changed = patches.filter((patch) => patch.operation === "replace").length + deduped;
	const reviewed = patches.filter((patch) => patch.operation === "append_review").length;
	const summary = `Curated memory: ${changed} updated, ${reviewed} review item(s), ${runId}`;
	if (!options.dryRun && patches.length > 0) await options.memoryStore.saveState({ lastRunAt: runId, lastRunSummary: summary });
	return { runId, changed, reviewed, deduped, patches, summary, dryRun: Boolean(options.dryRun) };
}

async function applyPatches(memoryStore: MemoryStore, entriesByTarget: Map<MemoryTarget, string[]>, patches: MemoryPatch[]): Promise<void> {
	for (const patch of patches) {
		if (patch.operation === "append_review") {
			const storedReviewEntries = entriesByTarget.get("review");
			const entries = storedReviewEntries || await memoryStore.readEntries("review");
			if (patch.newText && !entries.includes(patch.newText)) entries.push(patch.newText);
			entriesByTarget.set("review", entries);
			continue;
		}

		const storedEntries = entriesByTarget.get(patch.target);
		const entries = storedEntries || await memoryStore.readEntries(patch.target);
		if (patch.operation === "replace") {
			const index = entries.findIndex((entry) => entry === patch.oldText);
			if (index < 0) throw new Error(`Patch target entry not found in ${patch.target}`);
			entries[index] = patch.newText || "";
		} else if (patch.operation === "dedupe") {
			entriesByTarget.set(patch.target, dedupeEntries(entries));
			continue;
		}
		entriesByTarget.set(patch.target, entries);
	}

	for (const [target, entries] of entriesByTarget) await memoryStore.writeEntries(target, dedupeEntries(entries));
}

function dedupeEntries(entries: string[]): string[] {
	return [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))];
}
