import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEntry, parseMetadata, renderEntry } from "../src/index.ts";

test("parses metadata", () => {
	assert.deepEqual(parseMetadata("[type:event status:planned date:2026-06-06]"), {
		type: "event",
		status: "planned",
		date: "2026-06-06",
	});
});

test("leaves malformed metadata as plain body", () => {
	const entry = parseEntry("[type:event status:planned\nUser plans to watch NBA.");
	assert.equal(entry.hasMetadata, false);
	assert.equal(renderEntry(entry), "[type:event status:planned\nUser plans to watch NBA.");
});
