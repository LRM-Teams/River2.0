import * as fs from "node:fs";
import * as path from "node:path";
import type { EvolutionConfig } from "./config.ts";
import { pathExists, replaceDirFrom } from "./file-utils.ts";
import { pushEvolution } from "./git.ts";
import { readManifest, type EvolutionManifest } from "./manifest.ts";
import { createEvolutionSnapshot, syncEvolutionAfterChange, type SnapshotResult } from "./snapshot.ts";

export type RestoreTarget = "memory" | "skill-drafts" | "all";

export interface RestoreResult {
	restored: EvolutionManifest;
	preRestore: SnapshotResult;
	commit: ReturnType<typeof syncEvolutionAfterChange>;
	pushed: boolean;
}

export function restoreEvolutionSnapshot(config: EvolutionConfig, id: string, target: RestoreTarget = "all", sessionId?: string): RestoreResult {
	if (!config.enabled) throw new Error("Evolution versioning is disabled.");
	const snapshotDir = path.join(config.repoDir, "snapshots", id);
	if (!pathExists(snapshotDir)) throw new Error(`Snapshot not found: ${id}`);
	const manifest = readManifest(config, id);
	const preRestore = createEvolutionSnapshot(config, {
		reason: `pre-restore backup before ${id}`,
		trigger: "restore",
		sessionId,
		commitMessage: `memory: snapshot before restore ${id}`,
	});
	if (target === "memory" || target === "all") {
		replaceDirFrom(path.join(snapshotDir, "memory"), config.memoryDir);
	}
	if (target === "skill-drafts" || target === "all") {
		replaceDirFrom(path.join(snapshotDir, "skill-drafts"), config.skillDraftsDir);
	}
	fs.mkdirSync(config.memoryDir, { recursive: true });
	fs.mkdirSync(config.skillDraftsDir, { recursive: true });
	const commit = syncEvolutionAfterChange(config, `memory: restore snapshot ${id}`);
	let pushed = false;
	if (config.autoPush) {
		pushEvolution(config);
		pushed = true;
	}
	return { restored: manifest, preRestore, commit, pushed };
}
