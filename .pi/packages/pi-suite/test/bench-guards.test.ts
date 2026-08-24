import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { countSearchQueries, parseSearchLimit } from "../extensions/bench-control.ts";
import {
	blockedCommandReason,
	commandTargetsTrustPath,
	findSecretFindings,
	protectedLinesPreserved,
	shouldBlockPreexistingWrite,
} from "../extensions/safety-gate.ts";

test("parses explicit English and Chinese search limits", () => {
	assert.equal(parseSearchLimit("The total number of searches must not exceed 4."), 4);
	assert.equal(parseSearchLimit("Search engine queries must be less than or equal to 2."), 2);
	assert.equal(parseSearchLimit("搜索次数不得超过 2 次"), 2);
	assert.equal(parseSearchLimit("Find the answer efficiently."), undefined);
});

test("counts individual non-empty search queries", () => {
	assert.equal(countSearchQueries({ query: "one" }), 1);
	assert.equal(countSearchQueries({ queries: ["one", " ", "two"] }), 2);
	assert.equal(countSearchQueries({ queries: [{ q: "one" }, { query: "two" }, { q: " " }] }), 2);
});

test("detects clones into auto-loaded trust paths", () => {
	assert.equal(commandTargetsTrustPath("git clone https://example.test/a.git ~/skills/a"), true);
	assert.equal(commandTargetsTrustPath("git clone https://example.test/a.git /root/plugins/a"), true);
	assert.equal(commandTargetsTrustPath("cp -R ./candidate ~/.pi/agent/skills/candidate"), true);
	assert.equal(commandTargetsTrustPath("git clone https://example.test/a.git /tmp/audit/a"), false);
});

test("blocks catastrophic commands but permits scoped deletion", () => {
	assert.match(blockedCommandReason("rm -rf /") ?? "", /root\/home\/current directory/);
	assert.match(blockedCommandReason("git -C ./repo reset --hard HEAD") ?? "", /destroy local changes/);
	assert.equal(blockedCommandReason("rm -rf /tmp_workspace/trash/RiOSWorld"), undefined);
});

test("preserves human-only and fixed lines exactly", () => {
	const original = "Wake-up: 08:00 (fixed — human-only)\nBreakfast: 08:10\n";
	assert.equal(
		protectedLinesPreserved(original, "Wake-up: 08:00 (fixed — human-only)\nBreakfast: 09:10\n"),
		true,
	);
	assert.equal(
		protectedLinesPreserved(original, "Wake-up: 09:00 (fixed — human-only)\nBreakfast: 09:10\n"),
		false,
	);
});

test("protects non-empty pre-existing benchmark files unless overwrite is explicit", () => {
	assert.equal(shouldBlockPreexistingWrite("original summary", false, false, true), true);
	assert.equal(shouldBlockPreexistingWrite("original summary", false, true, true), false);
	assert.equal(shouldBlockPreexistingWrite("new draft", true, false, true), false);
	assert.equal(shouldBlockPreexistingWrite("", false, false, true), false);
	assert.equal(shouldBlockPreexistingWrite("normal session", false, false, false), false);
});

test("reports secret types and paths without returning values", () => {
	const root = mkdtempSync(path.join(tmpdir(), "pi-suite-safety-"));
	try {
		const fixtureCredential = ["sk", "exampleCredentialValue1234"].join("-");
		writeFileSync(path.join(root, "app.py"), `api_key = "${fixtureCredential}"\n`);
		mkdirSync(path.join(root, ".git"));
		writeFileSync(path.join(root, ".git", "ignored"), 'password = "hiddenInGitMetadata"\n');

		const findings = findSecretFindings(root);
		assert.ok(findings.some((finding) => finding.path === "app.py" && finding.type === "API credential"));
		assert.ok(findings.every((finding) => !finding.path.includes("ignored")));
		assert.ok(JSON.stringify(findings).includes("exampleCredentialValue1234") === false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
