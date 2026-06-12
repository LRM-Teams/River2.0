import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createEvolutionSnapshot,
	getEvolutionGitStatus,
	LEGACY_SHARED_EVOLUTION_REMOTE,
	listManifests,
	resolveEvolutionConfig,
	restoreEvolutionSnapshot,
	syncEvolutionAfterChange,
} from "../src/index.ts";

function testConfig() {
	const root = mkdtempSync(join(tmpdir(), "pi-memory-evolution-"));
	const memoryDir = join(root, "memory");
	const skillDraftsDir = join(root, "skill-drafts");
	const repoDir = join(root, "evolution");
	return {
		root,
		memoryDir,
		skillDraftsDir,
		repoDir,
		config: resolveEvolutionConfig(memoryDir, {
			PI_EVOLUTION_DIR: repoDir,
			PI_EVOLUTION_AUTO_PUSH: "0",
			HOME: root,
		}),
	};
}

test("creates snapshot, manifest, current mirrors, and git commit", () => {
	const { memoryDir, skillDraftsDir, repoDir, config } = testConfig();
	mkdirSync(memoryDir, { recursive: true });
	mkdirSync(skillDraftsDir, { recursive: true });
	writeFileSync(join(memoryDir, "MEMORY.md"), "stable memory\n", { encoding: "utf-8", flag: "w" });
	writeFileSync(join(skillDraftsDir, "draft.txt"), "draft\n", { encoding: "utf-8", flag: "w" });

	const result = createEvolutionSnapshot(config, { reason: "test snapshot", trigger: "test", commitMessage: "memory: test snapshot" });

	assert.ok(result.manifest?.id);
	assert.equal(result.commit?.committed, true);
	assert.equal(existsSync(join(repoDir, "memory", "MEMORY.md")), true);
	assert.equal(existsSync(join(repoDir, "skill-drafts", "draft.txt")), true);
	assert.equal(existsSync(join(repoDir, "snapshots", result.manifest.id, "manifest.json")), true);
	assert.equal(existsSync(join(repoDir, "manifests", `${result.manifest.id}.json`)), true);
	assert.equal(listManifests(config, 1)[0].reason, "test snapshot");
	assert.match(getEvolutionGitStatus(config).lastCommit || "", /memory: test snapshot/);
});

test("local-only config removes the legacy shared team remote", () => {
	const { config, repoDir } = testConfig();
	mkdirSync(repoDir, { recursive: true });
	execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
	execFileSync("git", ["remote", "add", "origin", LEGACY_SHARED_EVOLUTION_REMOTE], { cwd: repoDir, stdio: "ignore" });

	createEvolutionSnapshot(config, { reason: "local migration", trigger: "test", commitMessage: "memory: local migration" });

	assert.equal(getEvolutionGitStatus(config).remote, null);
});

test("sync does not create empty commits when nothing changed", () => {
	const { memoryDir, config } = testConfig();
	mkdirSync(memoryDir, { recursive: true });
	writeFileSync(join(memoryDir, "MEMORY.md"), "stable memory\n", { encoding: "utf-8", flag: "w" });
	createEvolutionSnapshot(config, { reason: "test snapshot", trigger: "test", commitMessage: "memory: first" });

	const result = syncEvolutionAfterChange(config, "memory: no-op");

	assert.equal(result?.committed, false);
});

test("restore creates pre-restore backup and restores selected target", () => {
	const { memoryDir, skillDraftsDir, config } = testConfig();
	mkdirSync(memoryDir, { recursive: true });
	mkdirSync(skillDraftsDir, { recursive: true });
	writeFileSync(join(memoryDir, "MEMORY.md"), "before\n", { encoding: "utf-8", flag: "w" });
	writeFileSync(join(skillDraftsDir, "draft.txt"), "draft before\n", { encoding: "utf-8", flag: "w" });
	const snapshot = createEvolutionSnapshot(config, { reason: "restore point", trigger: "test", commitMessage: "memory: restore point" });
	writeFileSync(join(memoryDir, "MEMORY.md"), "after\n", "utf-8");
	writeFileSync(join(skillDraftsDir, "draft.txt"), "draft after\n", "utf-8");

	const result = restoreEvolutionSnapshot(config, snapshot.manifest?.id || "", "memory");

	assert.equal(readFileSync(join(memoryDir, "MEMORY.md"), "utf-8"), "before\n");
	assert.equal(readFileSync(join(skillDraftsDir, "draft.txt"), "utf-8"), "draft after\n");
	assert.ok(result.preRestore.manifest?.id);
	assert.match(getEvolutionGitStatus(config).lastCommit || "", /memory: restore snapshot/);
});
