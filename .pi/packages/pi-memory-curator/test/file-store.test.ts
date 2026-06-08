import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ENTRY_DELIMITER, FileMemoryStore } from "../src/index.ts";

test("writes file updates atomically", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-curator-"));
	const store = new FileMemoryStore(dir);
	await store.writeEntries("state", ["one", "two"]);
	assert.equal(readFileSync(join(dir, "STATE.md"), "utf-8"), `one${ENTRY_DELIMITER}two`);
	assert.deepEqual(await store.readEntries("state"), ["one", "two"]);
});
