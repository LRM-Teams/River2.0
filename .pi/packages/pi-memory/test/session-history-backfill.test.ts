import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { _resetBaseDir, _setBaseDir, backfillSessionHistoryLearning } from "../index.ts";

function message(role: string, content: unknown, extra: Record<string, unknown> = {}) {
	return JSON.stringify({ type: "message", timestamp: "2026-06-20T00:00:00.000Z", message: { role, content, ...extra } });
}

test("backfills historical session tool evidence once and records state", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-history-"));
	const memoryDir = join(dir, "memory");
	const sessionsDir = join(dir, "sessions");
	_setBaseDir(memoryDir, join(dir, "drafts"));
	try {
		mkdirSync(sessionsDir, { recursive: true });
		const filePath = join(sessionsDir, "2026-06-20T00-00-00-000Z_session.jsonl");
		writeFileSync(filePath, [
			message("assistant", [{ type: "toolCall", id: "fail", name: "bash", arguments: { command: "npm test" } }]),
			message("toolResult", [{ type: "text", text: "Command exited with code 1\nError: broken test" }], { toolCallId: "fail", toolName: "bash", isError: true }),
			message("assistant", [{ type: "toolCall", id: "edit", name: "edit", arguments: { path: "src/a.ts" } }]),
			message("toolResult", [{ type: "text", text: "Edited src/a.ts" }], { toolCallId: "edit", toolName: "edit" }),
			message("assistant", [{ type: "toolCall", id: "pass", name: "bash", arguments: { command: "npm test" } }]),
			message("toolResult", [{ type: "text", text: "TAP version 13\nok 1" }], { toolCallId: "pass", toolName: "bash" }),
		].join("\n"));

		const first = await backfillSessionHistoryLearning(undefined, { paths: [sessionsDir], dryRun: false, runCuratorAfter: false });
		assert.equal(first.scanned, 1);
		assert.equal(first.processed, 1);
		assert.equal(first.candidates, 1);
		assert.match(readFileSync(join(memoryDir, "REVIEW.md"), "utf-8"), /source:session_history_2026-06-20/);
		assert.match(readFileSync(join(memoryDir, ".session-history-backfill-state.json"), "utf-8"), /session\.jsonl/);

		const second = await backfillSessionHistoryLearning(undefined, { paths: [sessionsDir], dryRun: false, runCuratorAfter: false });
		assert.equal(second.processed, 0);
		assert.equal(second.skipped, 1);
		assert.equal(second.candidates, 0);
	} finally {
		_resetBaseDir();
	}
});
