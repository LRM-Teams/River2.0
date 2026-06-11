import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	FileMemoryStore,
	applyReviewLifecycle,
	approveMemoryPromotion,
	proposeMemoryPromotions,
	rejectReviewItem,
	upsertReviewCandidate,
} from "../src/index.ts";

test("proposes and approves memory promotion from repeated preference", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-promotions-"));
	const store = new FileMemoryStore(dir);
	await upsertReviewCandidate(store, { kind: "preference", confidence: "medium", signature: "User prefers direct answers", summary: "User prefers concise direct answers.", targetHints: ["memory"] });
	await upsertReviewCandidate(store, { kind: "preference", confidence: "medium", signature: "User prefers direct answers", summary: "User prefers concise direct answers.", targetHints: ["memory"] });

	const proposed = await proposeMemoryPromotions(store);
	assert.equal(proposed.created, 1);
	const approved = await approveMemoryPromotion(store, proposed.proposalIds[0]);
	assert.equal(approved.target, "user");
	assert.deepEqual(await store.readEntries("user"), ["[type:preference]\nUser prefers concise direct answers."]);
	assert.match((await store.readEntries("review")).join("\n"), /status:approved/);
});

test("review lifecycle marks stale low-confidence candidates and reject preserves entries", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-promotions-"));
	const store = new FileMemoryStore(dir);
	await upsertReviewCandidate(store, { kind: "project_fact", confidence: "low", signature: "Old uncertain fact", date: "2026-01-01" });
	const id = (await store.readEntries("review"))[0].match(/id:([^\s]+)/)?.[1];
	assert.ok(id);

	const lifecycle = await applyReviewLifecycle(store, new Date("2026-05-01T00:00:00.000Z"));
	assert.equal(lifecycle.changed, 1);
	assert.match((await store.readEntries("review")).join("\n"), /status:archived/);

	await rejectReviewItem(store, id, "rejected");
	const review = await store.readEntries("review");
	assert.equal(review.length, 1);
	assert.match(review[0], /status:rejected/);
});
