import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileMemoryStore, approvePendingSkillDrafts, approveSkillDraft, listSkillDraftProposals, proposeSkillDrafts, upsertReviewCandidate } from "../src/index.ts";

test("proposes skill draft from repeated skill candidate", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-skills-"));
	const store = new FileMemoryStore(join(dir, "memory"));
	const draftsDir = join(dir, "skill-drafts");
	for (const evidence of ["first pass", "second pass"]) {
		await upsertReviewCandidate(store, {
			kind: "skill_candidate",
			confidence: "medium",
			signature: "fix non erasable TypeScript syntax in pi source",
			summary: "Replace enum and parameter properties with erasable syntax.",
			targetHints: ["skill"],
			evidence,
		});
	}

	const result = await proposeSkillDrafts(store, { draftsDir });
	assert.equal(result.created, 1);
	assert.equal(result.proposals[0].id.startsWith("skill_"), true);
	assert.match(result.proposals[0].promotesTo, /skill-drafts/);
	const review = await store.readEntries("review");
	assert.equal(review.filter((entry) => entry.includes("kind:skill_promotion")).length, 1);

	const second = await proposeSkillDrafts(store, { draftsDir });
	assert.equal(second.created, 0);
});

test("approves skill proposal into disabled draft and marks proposal approved", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-skills-"));
	const store = new FileMemoryStore(join(dir, "memory"));
	const draftsDir = join(dir, "skill-drafts");
	for (const evidence of ["first pass", "second pass", "third pass"]) {
		await upsertReviewCandidate(store, {
			kind: "skill_candidate",
			confidence: "medium",
			signature: "fix non erasable TypeScript syntax in pi source",
			summary: "Replace enum and parameter properties with erasable syntax.",
			targetHints: ["skill"],
			evidence,
		});
	}
	const proposed = await proposeSkillDrafts(store, { draftsDir });

	const approved = await approveSkillDraft(store, proposed.proposals[0].id);
	assert.equal(existsSync(approved.path), true);
	const draftContent = readFileSync(approved.path, "utf-8");
	assert.match(draftContent, /description: Use when fix non erasable typescript syntax in pi source\./);
	assert.match(draftContent, /## Trigger signals/);
	assert.match(draftContent, /## Validation/);
	const proposals = await listSkillDraftProposals(store);
	assert.equal(proposals.length, 1);
	const review = await store.readEntries("review");
	assert.match(review.join("\n"), /status:approved/);
});

test("auto-approves pending skill proposals into disabled drafts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-skills-"));
	const store = new FileMemoryStore(join(dir, "memory"));
	const draftsDir = join(dir, "skill-drafts");
	await upsertReviewCandidate(store, {
		kind: "skill_candidate",
		confidence: "high",
		signature: "restore pi session jsonl",
		summary: "Resume a Pi session from a saved JSONL with pi --session.",
		targetHints: ["skill"],
		evidence: "User needed a repeatable session restore command.",
	});
	await proposeSkillDrafts(store, { draftsDir });

	const approved = await approvePendingSkillDrafts(store);
	assert.equal(approved.length, 1);
	assert.equal(existsSync(approved[0].path), true);
	assert.match((await store.readEntries("review")).join("\n"), /status:approved/);
});
