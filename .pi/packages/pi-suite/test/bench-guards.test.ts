import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	countSearchQueries,
	finalizationBlockReason,
	isSupportedPiVersion,
	parseSearchLimit,
} from "../extensions/bench-control.ts";
import { contactSheetLayout, retryDelayMs } from "../extensions/media-tools.ts";
import {
	blockedCommandReason,
	commandTargetsTrustPath,
	findSecretFindings,
	overwriteAuthorization,
	protectedLinesPreserved,
	shellOverwriteTargets,
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
	assert.equal(countSearchQueries({ q: "one" }), 1);
	assert.equal(countSearchQueries({ queries: ["one", " ", "two"] }), 2);
	assert.equal(countSearchQueries({ search_queries: ["one", "two"] }), 2);
	assert.equal(countSearchQueries({ queries: [{ q: "one" }, { query: "two" }, { q: " " }] }), 2);
});

test("requires the current Pi release and blocks exploration during finalization", () => {
	assert.equal(isSupportedPiVersion("0.84.3"), true);
	assert.equal(isSupportedPiVersion("0.85.0-beta.1"), true);
	assert.equal(isSupportedPiVersion("0.84.2"), false);
	assert.match(finalizationBlockReason("web_search", { query: "x" }) ?? "", /searches/);
	assert.match(finalizationBlockReason("gemini_vision", {}) ?? "", /vision/);
	assert.match(finalizationBlockReason("bash", { command: "pip install opencv-python" }) ?? "", /installations/);
	assert.equal(finalizationBlockReason("bash", { command: "mkdir -p results && printf ok > results/out.md" }), undefined);
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

test("overwrite authorization is explicit and negation-aware", () => {
	assert.equal(overwriteAuthorization("Overwrite the existing summary file."), true);
	assert.equal(overwriteAuthorization("Update the existing schedule file."), true);
	assert.equal(overwriteAuthorization("Do not overwrite the existing summary file."), false);
	assert.equal(overwriteAuthorization("不要覆盖已有文件，创建新的摘要。"), false);
	assert.equal(overwriteAuthorization("Update the analysis."), undefined);
});

test("detects common shell overwrite targets", () => {
	const cwd = "/tmp/workspace";
	assert.deepEqual(shellOverwriteTargets("printf ok > results.md", cwd), ["/tmp/workspace/results.md"]);
	assert.deepEqual(shellOverwriteTargets("cp draft.md final.md", cwd), ["/tmp/workspace/final.md"]);
	assert.deepEqual(shellOverwriteTargets("sed -i 's/a/b/' plan.md", cwd), ["/tmp/workspace/plan.md"]);
	assert.deepEqual(shellOverwriteTargets("pip install plan.md", cwd), []);
	assert.deepEqual(shellOverwriteTargets("printf ok >> append-only.log", cwd), []);
});

test("builds deterministic media retry delays and contact-sheet layouts", () => {
	assert.equal(retryDelayMs(0, 0), 400);
	assert.equal(retryDelayMs(1, 1), 1_000);
	assert.equal(contactSheetLayout(5, 3, 100, 80), "0_0|100_0|200_0|0_80|100_80");
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
