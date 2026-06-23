import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	disableMemorySkill,
	enableMemorySkill,
	ensureAgentRoot,
	formatEnabledSkillsForPrompt,
	listMemorySkills,
	receiveDelivery,
} from "../src/index.ts";

function agentEnv() {
	const root = mkdtempSync(join(tmpdir(), "pi-memory-skill-life-"));
	const agentRoot = join(root, "workspace_1", ".pi", "agents", "agent_a");
	const env = {
		HOME: root,
		PI_AGENT_ROOT: agentRoot,
		MULTICA_WORKSPACE_ID: "workspace_1",
		MULTICA_AGENT_ID: "agent_a",
	};
	ensureAgentRoot(env);
	return { root, agentRoot, env };
}

function writeSkill(path: string, name: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `---\nname: ${name}\ndescription: Use ${name}.\n---\n# ${name}\n`, "utf-8");
}

test("enables and disables a draft skill without deleting the draft", () => {
	const { agentRoot, env } = agentEnv();
	const draftDir = join(agentRoot, "skills", "drafts", "draft-one");
	writeSkill(join(draftDir, "SKILL.md"), "draft-one");
	mkdirSync(join(draftDir, "templates"), { recursive: true });
	writeFileSync(join(draftDir, "templates", "prompt.md"), "supporting file\n", "utf-8");

	let skills = listMemorySkills(env);
	assert.equal(skills.drafts.length, 1);
	assert.equal(skills.enabled.length, 0);

	const enabled = enableMemorySkill("draft:draft-one", { env });
	assert.equal(enabled.enabled.name, "draft-one");
	assert.equal(existsSync(join(agentRoot, "skills", "enabled", "draft-one", "SKILL.md")), true);
	assert.equal(existsSync(join(agentRoot, "skills", "enabled", "draft-one", "templates", "prompt.md")), true);
	assert.equal(existsSync(join(agentRoot, "skills", "drafts", "draft-one", "SKILL.md")), true);
	assert.match(readFileSync(join(agentRoot, "memory", "audit", "skill-lifecycle.jsonl"), "utf-8"), /"action":"enable"/);

	const prompt = formatEnabledSkillsForPrompt(env);
	assert.match(prompt, /<available_skills>/);
	assert.match(prompt, /draft-one/);
	assert.match(prompt, /skills\/enabled\/draft-one\/SKILL.md/);

	const disabled = disableMemorySkill("draft-one", env);
	assert.equal(disabled.removed, true);
	skills = listMemorySkills(env);
	assert.equal(skills.enabled.length, 0);
	assert.equal(skills.drafts.length, 1);
});

test("enables a generated skill delivery by generated id", () => {
	const { agentRoot, env } = agentEnv();
	receiveDelivery({
		id: "delivery_1",
		shared_unit_id: "unit_skill_1",
		unit_type: "skill",
		content: "---\nname: shared-demo\ndescription: Use for tests.\n---\n# Shared Demo\n",
		files: [{ path: "templates/prompt.md", content: "shared supporting file\n" }],
	}, env);

	const enabled = enableMemorySkill("generated:unit_skill_1", { env });
	assert.equal(enabled.source.kind, "generated");
	assert.equal(enabled.enabled.name, "shared-demo");
	assert.equal(existsSync(join(agentRoot, "skills", "enabled", "shared-demo", "templates", "prompt.md")), true);
	assert.equal(existsSync(join(agentRoot, "skills", "enabled", "shared-demo", ".pi-skill-enabled.json")), true);
	const manifest = readFileSync(join(agentRoot, "skills", "enabled", "shared-demo", ".pi-skill-enabled.json"), "utf-8");
	assert.match(manifest, /generated:unit_skill_1/);
});
