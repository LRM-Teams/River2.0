import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	FileMemoryStore,
	createReviewCandidateId,
	parseReviewCandidate,
	renderReviewCandidate,
	upsertReviewCandidate,
	validateReviewCandidateInput,
} from "../src/index.ts";

test("renders and parses review candidate metadata", () => {
	const entry = renderReviewCandidate(
		{
			kind: "bug_fix",
			confidence: "high",
			signature: "npm run check failed on stale metadata order",
			summary: "Keep review metadata stable.",
			targetHints: ["memory", "skill"],
		},
		new Date("2026-06-10T00:00:00.000Z"),
	);

	const candidate = parseReviewCandidate(entry);
	assert.ok(candidate);
	assert.equal(candidate.id, createReviewCandidateId("bug_fix", "npm run check failed on stale metadata order"));
	assert.equal(candidate.kind, "bug_fix");
	assert.equal(candidate.confidence, "high");
	assert.equal(candidate.seen, 1);
	assert.match(entry, /target_hints:memory,skill/);
	assert.match(entry, /Signature: npm run check failed on stale metadata order/);
});

test("rejects invalid target hints", () => {
	assert.deepEqual(
		validateReviewCandidateInput({
			kind: "skill_candidate",
			confidence: "medium",
			signature: "Reusable flow",
			targetHints: ["workflow" as "memory"],
		}),
		["invalid target hint 'workflow'"],
	);
});

test("upserts duplicate candidates by normalized signature", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-learning-"));
	const store = new FileMemoryStore(dir);

	const first = await upsertReviewCandidate(
		store,
		{
			kind: "bug_fix",
			confidence: "medium",
			signature: "NPM run check failed: stale metadata order.",
			evidence: "first failure",
		},
		new Date("2026-06-10T00:00:00.000Z"),
	);
	const second = await upsertReviewCandidate(
		store,
		{
			kind: "bug_fix",
			confidence: "high",
			signature: "npm run check failed stale metadata order",
			evidence: "second validation",
		},
		new Date("2026-06-11T00:00:00.000Z"),
	);

	const entries = await store.readEntries("review");
	assert.equal(first.merged, false);
	assert.equal(second.merged, true);
	assert.equal(entries.length, 1);
	const candidate = parseReviewCandidate(entries[0]);
	assert.ok(candidate);
	assert.equal(candidate.id, first.id);
	assert.equal(candidate.seen, 2);
	assert.equal(candidate.confidence, "high");
	assert.equal(candidate.lastSeen, "2026-06-11");
	assert.match(entries[0], /Evidence: first failure/);
	assert.match(entries[0], /Evidence: second validation/);
});

test("does not merge unrelated candidates or malformed review entries", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-learning-"));
	const store = new FileMemoryStore(dir);
	await store.writeEntries("review", ["[type:review status:candidate]\nSignature: malformed"]);

	await upsertReviewCandidate(store, {
		kind: "preference",
		confidence: "medium",
		signature: "User prefers concise answers",
	});
	await upsertReviewCandidate(store, {
		kind: "project_fact",
		confidence: "medium",
		signature: "Project stores specs under .pi/docs",
	});

	const entries = await store.readEntries("review");
	assert.equal(entries.length, 3);
	assert.equal(entries[0], "[type:review status:candidate]\nSignature: malformed");
});
