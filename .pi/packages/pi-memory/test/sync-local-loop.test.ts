import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	appendEvolutionCandidate,
	appendFeedbackEvent,
	buildFeedbackEvent,
	compactProcessedReviewEntries,
	ensureAgentRoot,
	receiveDelivery,
} from "../src/index.ts";

function agentEnv() {
	const root = mkdtempSync(join(tmpdir(), "pi-memory-loop-"));
	const agentRoot = join(root, "workspace_1", ".pi", "agents", "agent_a");
	const env = {
		HOME: root,
		PI_AGENT_ROOT: agentRoot,
		MULTICA_WORKSPACE_ID: "workspace_1",
		MULTICA_AGENT_ID: "agent_a",
		MULTICA_RUN_ID: "run_1",
	};
	ensureAgentRoot(env);
	return { root, agentRoot, env };
}

test("sync queue writes share candidates and blocks secret-like payloads", () => {
	const { agentRoot, env } = agentEnv();
	const result = appendEvolutionCandidate({
		type: "memory",
		content: "Prefer LSP rename for cross-file refactors.",
		tags: ["coding", "lsp"],
		source: "local_curator",
		suggested_scope: "workspace",
		status: "candidate",
	}, env);
	assert.equal(result.appended, true);
	assert.equal(existsSync(join(agentRoot, "sync_queue", "memory-candidates.jsonl")), true);
	assert.throws(() => appendEvolutionCandidate({
		type: "memory",
		content: "api_key=sk_test_secret_should_not_upload_123456789",
		tags: ["secret"],
		source: "local_curator",
		suggested_scope: "workspace",
		status: "candidate",
	}, env), /secret-like content/);
});

test("downflow receive writes only inbox/cache/generated locations", () => {
	const { agentRoot, env } = agentEnv();
	const memoryResult = receiveDelivery({
		id: "delivery_1",
		shared_unit_id: "unit_memory_1",
		unit_type: "memory",
		content: "Shared memory that matches coding tasks.",
		tags: ["coding"],
	}, env);
	assert.equal(memoryResult.accepted, true);
	assert.equal(existsSync(join(agentRoot, "inbox", "memory", "unit_memory_1.json")), true);
	assert.equal(existsSync(join(agentRoot, "shared-cache", "memory", "unit_memory_1.json")), true);
	assert.equal(readFileSync(join(agentRoot, "memory", "MEMORY.md"), "utf-8"), "");

	const skillResult = receiveDelivery({
		id: "delivery_2",
		shared_unit_id: "unit_skill_1",
		unit_type: "skill",
		content: "---\nname: shared-demo\ndescription: Use for tests.\n---\n# Shared Demo\n",
	}, env);
	assert.equal(skillResult.accepted, true);
	assert.equal(existsSync(join(agentRoot, "inbox", "skills", "unit_skill_1", "SKILL.md")), true);
	assert.equal(existsSync(join(agentRoot, "skills", "generated", "unit_skill_1", "SKILL.md")), true);
	assert.equal(existsSync(join(agentRoot, "skills", "enabled", "unit_skill_1", "SKILL.md")), false);
});

test("feedback queue appends scoped feedback events", () => {
	const { agentRoot, env } = agentEnv();
	const event = buildFeedbackEvent({
		shared_unit_id: "unit_memory_1",
		unit_type: "memory",
		event: "used",
		outcome: "success",
	}, env);
	appendFeedbackEvent(event, env);
	const feedback = readFileSync(join(agentRoot, "feedback", "feedback.jsonl"), "utf-8");
	assert.match(feedback, /"workspace_id":"workspace_1"/);
	assert.match(feedback, /"agent_id":"agent_a"/);
	assert.match(feedback, /"run_id":"run_1"/);
});

test("review compact removes old processed entries but keeps pending proposals", () => {
	const review = [
		`[type:review status:approved id:mem_old kind:memory_promotion approved_at:2026-01-01T00:00:00.000Z]\nOld approved`,
		`[type:review status:proposed id:mem_pending kind:memory_promotion]\nPending`,
	].join("\n§\n");
	const result = compactProcessedReviewEntries(review, { now: new Date("2026-03-01T00:00:00.000Z"), compactDays: 30 });
	assert.equal(result.removed, 1);
	assert.equal(result.activeEntries.length, 1);
	assert.match(result.activeEntries[0], /mem_pending/);
});
