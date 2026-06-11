import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileMemoryStore, JsonlAuditLog, runMemoryCuratorOnce } from "../src/index.ts";

test("curates entries, deduplicates exact duplicates, and writes audit", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-curator-"));
	const store = new FileMemoryStore(dir);
	await store.writeEntries("state", [
		"[type:event status:planned date:2026-06-06]\nUser plans to watch NBA.",
		"[type:event status:planned date:2026-06-06]\nUser plans to watch NBA.",
		"Plain note for 2026-06-06.",
	]);

	const result = await runMemoryCuratorOnce({
		memoryStore: store,
		auditLog: new JsonlAuditLog(dir),
		now: () => new Date("2026-06-08T03:00:00.000Z"),
	});

	assert.equal(result.changed, 2);
	assert.deepEqual(await store.readEntries("state"), [
		"[type:event status:past date:2026-06-06]\nUser had planned to watch NBA. Completion status unknown.",
		"Plain note for 2026-06-06.",
	]);
	assert.equal(existsSync(join(dir, "audit", "curator.jsonl")), true);
	const auditLines = readFileSync(join(dir, "audit", "curator.jsonl"), "utf-8").trim().split("\n");
	assert.equal(auditLines.length, 2);
});

test("dry run returns deterministic patches without writing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-curator-"));
	const store = new FileMemoryStore(dir);
	const raw = "[type:event status:planned date:2026-06-06]\nUser plans to watch NBA.";
	await store.writeEntries("state", [raw]);

	const result = await runMemoryCuratorOnce({
		memoryStore: store,
		now: () => new Date("2026-06-08T03:00:00.000Z"),
		dryRun: true,
	});

	assert.equal(result.patches.length, 1);
	assert.deepEqual(await store.readEntries("state"), [raw]);
});

test("no-op curator scan does not rewrite memory or review files", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-curator-"));
	const store = new FileMemoryStore(dir);
	await store.writeEntries("memory", ["[type:fact]\nStable fact."]);
	await store.writeEntries("review", ["[type:review status:candidate id:rev_test kind:preference confidence:medium seen:1 first_seen:2026-06-08 last_seen:2026-06-08]\nSignature: User prefers concise answers."]);
	const memoryPath = join(dir, "MEMORY.md");
	const reviewPath = join(dir, "REVIEW.md");
	const beforeMemory = statSync(memoryPath).mtimeMs;
	const beforeReview = statSync(reviewPath).mtimeMs;

	const result = await runMemoryCuratorOnce({
		memoryStore: store,
		now: () => new Date("2026-06-08T03:00:00.000Z"),
	});

	assert.equal(result.patches.length, 0);
	assert.equal(statSync(memoryPath).mtimeMs, beforeMemory);
	assert.equal(statSync(reviewPath).mtimeMs, beforeReview);
	assert.equal(existsSync(join(dir, "audit", "curator.jsonl")), false);
});
