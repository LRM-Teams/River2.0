import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEntry, renderEntry } from "../curator-core/metadata.ts";
import type { MemoryStore } from "../curator-store/types.ts";
import { parseReviewCandidate, type ParsedReviewCandidate } from "./candidates.ts";

export type SkillProposal = {
	id: string;
	sourceCandidateIds: string[];
	slug: string;
	description: string;
	title: string;
	body: string;
	promotesTo: string;
};

export type SkillProposalOptions = {
	draftsDir: string;
	seenThreshold?: number;
	now?: Date;
};

export type SkillProposalResult = {
	created: number;
	proposals: SkillProposal[];
};

export type SkillApprovalResult = {
	proposalId: string;
	path: string;
	content: string;
};

export async function proposeSkillDrafts(
	memoryStore: MemoryStore,
	options: SkillProposalOptions,
): Promise<SkillProposalResult> {
	const entries = await memoryStore.readEntries("review");
	const candidates = entries.map(parseReviewCandidate).filter((candidate): candidate is ParsedReviewCandidate => candidate !== null);
	const threshold = options.seenThreshold ?? 2;
	const proposals: SkillProposal[] = [];
	const existingProposalSources = new Set(
		entries
			.map((entry) => parseEntry(entry).metadata)
			.filter((metadata) => metadata.type === "review" && metadata.kind === "skill_promotion")
			.flatMap((metadata) => (metadata.source_candidate_ids || "").split(",").map((id) => id.trim()).filter(Boolean)),
	);

	for (const candidate of candidates) {
		if (!isSkillCandidateReady(candidate, threshold) || existingProposalSources.has(candidate.id)) continue;
		proposals.push(createSkillProposal(candidate, options.draftsDir));
	}

	if (proposals.length === 0) return { created: 0, proposals: [] };
	await memoryStore.writeEntries("review", [...entries, ...proposals.map(renderSkillProposalEntry)]);
	return { created: proposals.length, proposals };
}

export async function approveSkillDraft(memoryStore: MemoryStore, proposalId: string): Promise<SkillApprovalResult> {
	const entries = await memoryStore.readEntries("review");
	const index = entries.findIndex((entry) => parseEntry(entry).metadata.id === proposalId);
	if (index < 0) throw new Error(`No review proposal found for id '${proposalId}'.`);
	const parsed = parseEntry(entries[index]);
	if (parsed.metadata.type !== "review" || parsed.metadata.kind !== "skill_promotion" || parsed.metadata.status !== "proposed") {
		throw new Error(`Review entry '${proposalId}' is not a proposed skill promotion.`);
	}
	const path = parsed.metadata.promotes_to;
	if (!path) throw new Error(`Skill proposal '${proposalId}' has no promotes_to path.`);
	const content = buildSkillDraftFromProposal(parsed.body);
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path)) {
		const existing = readFileSync(path, "utf-8");
		if (existing !== content) throw new Error(`Skill draft already exists at '${path}'.`);
	} else {
		writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
	}
	const approved = renderEntry({
		...parsed,
		metadata: { ...parsed.metadata, status: "approved", approved_at: new Date().toISOString() },
		body: `${parsed.body.trim()}\nApplied: ${path}`,
	});
	const updated = [...entries];
	updated[index] = approved;
	await memoryStore.writeEntries("review", updated);
	return { proposalId, path, content };
}

export async function approvePendingSkillDrafts(memoryStore: MemoryStore, proposalIds: string[] = []): Promise<SkillApprovalResult[]> {
	const ids = new Set(proposalIds);
	for (const entry of await memoryStore.readEntries("review")) {
		const metadata = parseEntry(entry).metadata;
		if (metadata.type === "review" && metadata.kind === "skill_promotion" && metadata.status === "proposed" && metadata.id) {
			ids.add(metadata.id);
		}
	}
	const results: SkillApprovalResult[] = [];
	for (const id of ids) {
		results.push(await approveSkillDraft(memoryStore, id));
	}
	return results;
}

export async function listSkillDraftProposals(memoryStore: MemoryStore): Promise<SkillProposal[]> {
	const entries = await memoryStore.readEntries("review");
	return entries
		.map((entry) => parseEntry(entry))
		.filter((entry) => entry.metadata.type === "review" && entry.metadata.kind === "skill_promotion")
		.map((entry) => ({
			id: entry.metadata.id || "",
			sourceCandidateIds: (entry.metadata.source_candidate_ids || "").split(",").map((id) => id.trim()).filter(Boolean),
			slug: slugFromPath(entry.metadata.promotes_to || ""),
			description: bodyField(entry.body, "Description") || "",
			title: bodyField(entry.body, "Title") || "Skill Draft",
			body: entry.body,
			promotesTo: entry.metadata.promotes_to || "",
		}));
}

function isSkillCandidateReady(candidate: ParsedReviewCandidate, threshold: number): boolean {
	if (candidate.kind !== "skill_candidate" && !candidate.targetHints.includes("skill")) return false;
	if (candidate.confidence !== "high" && candidate.seen < threshold) return false;
	return candidate.seen >= threshold || candidate.confidence === "high";
}

function createSkillProposal(candidate: ParsedReviewCandidate, draftsDir: string): SkillProposal {
	const slug = slugify(candidate.signature);
	const title = titleFromSignature(candidate.signature);
	const description = `Use when ${candidate.signature.toLowerCase()}.`;
	const promotesTo = join(draftsDir, slug, "SKILL.md");
	const evidence = candidate.evidence.length ? candidate.evidence.map((item) => `- ${item}`).join("\n") : "- Source candidate evidence is in REVIEW.md.";
	const body = [
		`Title: ${title}`,
		`Description: ${description}`,
		`Source candidates: ${candidate.id}`,
		"Proposal: Draft a reusable skill from repeated reviewed evidence.",
		"",
		"Draft content:",
		"```md",
		"---",
		`name: ${slug}`,
		`description: ${description}`,
		"---",
		"",
		`# ${title}`,
		"",
		"## When to use",
		description,
		"",
		"## Trigger signals",
		"- The task matches the repeated source evidence or error/fix pattern.",
		"- The user wants a reusable method rather than a one-off fact.",
		"",
		"## Method",
		candidate.summary || candidate.signature,
		"",
		"## Validation",
		"Use the validation signal from the source evidence. If none is available, run the narrowest relevant check and report the result.",
		"",
		"## Stop / avoid",
		"Stop after validation passes, or report the remaining blocker. Avoid applying this skill when the evidence is project-specific or the trigger does not match.",
		"",
		"## Evidence",
		evidence,
		"```",
	].join("\n");
	return {
		id: `skill_${candidate.id.slice(4)}`,
		sourceCandidateIds: [candidate.id],
		slug,
		description,
		title,
		body,
		promotesTo,
	};
}

function renderSkillProposalEntry(proposal: SkillProposal): string {
	return renderEntry({
		metadata: {
			type: "review",
			status: "proposed",
			id: proposal.id,
			kind: "skill_promotion",
			confidence: "high",
			source_candidate_ids: proposal.sourceCandidateIds.join(","),
			promotes_to: proposal.promotesTo,
		},
		body: proposal.body,
		raw: "",
		hasMetadata: true,
	});
}

function buildSkillDraftFromProposal(body: string): string {
	const marker = "Draft content:";
	const markerIndex = body.indexOf(marker);
	if (markerIndex < 0) throw new Error("Skill proposal does not include draft content.");
	const fenced = body.slice(markerIndex + marker.length).trim();
	if (!fenced.startsWith("```md") || !fenced.endsWith("```")) throw new Error("Skill proposal draft content must be a markdown fence.");
	return `${fenced.slice(5, -3).trim()}\n`;
}

function bodyField(body: string, field: string): string | null {
	const prefix = `${field}:`;
	const line = body.split("\n").find((candidate) => candidate.startsWith(prefix));
	return line?.slice(prefix.length).trim() || null;
}

function slugify(value: string): string {
	const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
	return slug || "reviewed-skill";
}

function titleFromSignature(signature: string): string {
	return signature
		.replace(/[^a-zA-Z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.slice(0, 8)
		.map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
		.join(" ") || "Reviewed Skill";
}

function slugFromPath(value: string): string {
	const parts = value.split(/[\\/]+/).filter(Boolean);
	return parts.length > 1 ? parts[parts.length - 2] : "";
}
