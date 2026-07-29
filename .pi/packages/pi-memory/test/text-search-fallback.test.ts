import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { _resetBaseDir, _setBaseDir, searchTextMemories } from "../index.ts";

afterEach(() => {
	_resetBaseDir();
});

test("text fallback searches markdown memory recursively and ranks exact phrases first", () => {
	const memoryDir = mkdtempSync(join(tmpdir(), "pi-memory-text-search-"));
	mkdirSync(join(memoryDir, "daily"), { recursive: true });
	writeFileSync(
		join(memoryDir, "MEMORY.md"),
		[
			"# Memory",
			"",
			"The release command is ~/bin/publish-pi-suite.",
			"Keep the memory package installed.",
		].join("\n"),
	);
	writeFileSync(
		join(memoryDir, "daily", "2026-07-29.md"),
		"Discussed a generic release process and command-line qmd embeddings.",
	);
	writeFileSync(join(memoryDir, ".hidden.md"), "release command should not be indexed");
	writeFileSync(join(memoryDir, "ignored.txt"), "release command should not be indexed");
	_setBaseDir(memoryDir);

	const results = searchTextMemories("release command", 5);

	assert.equal(results.length, 2);
	assert.equal(results[0].path, "MEMORY.md");
	assert.match(results[0].content ?? "", /publish-pi-suite/);
	assert.equal(results[1].path, join("daily", "2026-07-29.md"));
	assert.equal(results.some((result) => result.path === ".hidden.md"), false);
});

test("text fallback supports case-insensitive terms and result limits", () => {
	const memoryDir = mkdtempSync(join(tmpdir(), "pi-memory-text-search-"));
	writeFileSync(join(memoryDir, "USER.md"), "User Prefers concise answers.\nAnother preference appears here.");
	_setBaseDir(memoryDir);

	const results = searchTextMemories("PREFERS preference", 1);

	assert.equal(results.length, 1);
	assert.equal(results[0].path, "USER.md");
	assert.match(results[0].content ?? "", /Prefers concise answers/);
});

test("text fallback rejects blank queries and non-positive limits", () => {
	assert.deepEqual(searchTextMemories("   "), []);
	assert.deepEqual(searchTextMemories("memory", 0), []);
});
