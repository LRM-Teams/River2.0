import { parseEntry } from "../curator-core/metadata.ts";
import type { MemoryStore } from "../curator-store/types.ts";
import type { PiAgentEnv } from "../paths/resolve-roots.ts";
import { appendEvolutionCandidate } from "../sync/queue.ts";

export type ShareCandidateGenerationResult = {
	created: number;
	skipped: number;
	errors: string[];
};

export async function generateShareCandidatesFromReview(memoryStore: MemoryStore, env: PiAgentEnv & Record<string, string | undefined> = process.env): Promise<ShareCandidateGenerationResult> {
	const result: ShareCandidateGenerationResult = { created: 0, skipped: 0, errors: [] };
	const entries = await memoryStore.readEntries("review");
	for (const entry of entries) {
		const parsed = parseEntry(entry);
		if (parsed.metadata.type !== "review") continue;
		if (!isShareable(parsed.metadata)) continue;
		const content = extractShareableContent(parsed.body);
		if (!content) {
			result.skipped += 1;
			continue;
		}
		try {
			const type = parsed.metadata.kind === "skill_promotion" || parsed.metadata.target_hints?.includes("skill") ? "skill" : "memory";
			const appended = appendEvolutionCandidate({
				type,
				content,
				tags: tagsFromEntry(parsed.metadata.tags || parsed.metadata.kind || "memory"),
				source: "local_curator",
				suggested_scope: suggestedScope(parsed.metadata.scope),
				status: "candidate",
				sensitivity: parsed.metadata.sensitivity as "none" | "local_path" | "personal" | "secret" | "unknown" | undefined,
				source_candidate_ids: (parsed.metadata.source_candidate_ids || parsed.metadata.id || "").split(",").map((id) => id.trim()).filter(Boolean),
			}, env);
			if (appended.appended) result.created += 1;
			else result.skipped += 1;
		} catch (error) {
			result.errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	return result;
}

function isShareable(metadata: Record<string, string>): boolean {
	if (metadata.sensitivity === "secret") return false;
	if (metadata.shareability === "team_candidate" || metadata.shareability === "team_ready") return true;
	if (["workspace", "project", "team", "global"].includes(metadata.scope || "")) return true;
	if (metadata.decision === "promote_share_candidate") return true;
	return false;
}

function extractShareableContent(body: string): string {
	const lines = body.split("\n");
	const memoryLine = lines.find((line) => line.startsWith("Memory:"));
	if (memoryLine) {
		const start = lines.indexOf(memoryLine);
		return [memoryLine.slice("Memory:".length).trim(), ...lines.slice(start + 1)].join("\n").trim();
	}
	const draftIndex = body.indexOf("Draft content:");
	if (draftIndex >= 0) return body.slice(draftIndex + "Draft content:".length).trim();
	return body.trim();
}

function tagsFromEntry(value: string): string[] {
	return value.split(/[ ,#]+/).map((tag) => tag.trim()).filter(Boolean).slice(0, 8);
}

function suggestedScope(value: string | undefined): "agent" | "workspace" | "project" | "team" | "global" | "agent_type" {
	if (value === "workspace" || value === "project" || value === "team" || value === "global") return value;
	return "workspace";
}
