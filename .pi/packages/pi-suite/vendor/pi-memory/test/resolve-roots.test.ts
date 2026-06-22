import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureAgentRoot, resolveAgentRoot, resolveMemoryRoot, resolveSkillDraftRoot } from "../src/index.ts";

test("resolver keeps standalone fallback roots", () => {
	const env = { HOME: "/home/tester" };
	assert.equal(resolveAgentRoot(env), undefined);
	assert.equal(resolveMemoryRoot(env), "/home/tester/.pi/agent/memory");
	assert.equal(resolveSkillDraftRoot(env), "/home/tester/.pi/agent/skill-drafts");
});

test("resolver honors explicit memory and skill roots", () => {
	const env = {
		HOME: "/home/tester",
		PI_MEMORY_DIR: "/tmp/pi-agent-a/memory",
		PI_SKILL_DRAFTS_DIR: "/tmp/pi-agent-a/skills/drafts",
	};
	assert.equal(resolveMemoryRoot(env), "/tmp/pi-agent-a/memory");
	assert.equal(resolveSkillDraftRoot(env), "/tmp/pi-agent-a/skills/drafts");
});

test("resolver derives Multica agent root without member id in v1", () => {
	const env = {
		HOME: "/home/tester",
		MULTICA_WORKSPACES_ROOT: "/tmp/multica",
		MULTICA_WORKSPACE_ID: "workspace_1",
		MULTICA_AGENT_ID: "agent_a",
		MULTICA_MEMBER_ID: "member_ignored",
	};
	assert.equal(resolveAgentRoot(env), "/tmp/multica/workspace_1/.pi/agents/agent_a");
	assert.equal(resolveMemoryRoot(env), "/tmp/multica/workspace_1/.pi/agents/agent_a/memory");
	assert.equal(resolveSkillDraftRoot(env), "/tmp/multica/workspace_1/.pi/agents/agent_a/skills/drafts");
});

test("ensureAgentRoot initializes Multica local self-evolution layout", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-root-"));
	const agentRoot = join(root, "workspace_1", ".pi", "agents", "agent_a");
	ensureAgentRoot({ PI_AGENT_ROOT: agentRoot, HOME: root });
	for (const rel of [
		"memory/MEMORY.md",
		"memory/USER.md",
		"memory/STATE.md",
		"memory/REVIEW.md",
		"memory/SCRATCHPAD.md",
		"memory/daily",
		"memory/audit",
		"skills/drafts",
		"skills/generated",
		"skills/enabled",
		"inbox/memory",
		"inbox/skills",
		"shared-cache/memory",
		"shared-cache/skills",
		"profile",
		"feedback/feedback.jsonl",
		"sync_queue",
	]) {
		assert.equal(existsSync(join(agentRoot, rel)), true, rel);
	}
});
