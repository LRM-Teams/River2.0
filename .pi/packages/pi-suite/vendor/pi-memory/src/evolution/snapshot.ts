import * as path from "node:path";
import type { EvolutionConfig } from "./config.ts";
import { copyDirContents, emptyDir } from "./file-utils.ts";
import { commitEvolutionChanges, ensureEvolutionRepo, type GitCommitResult } from "./git.ts";
import { buildManifest, createSnapshotId, writeManifest, type EvolutionManifest } from "./manifest.ts";
import { syncCurrentToEvolution } from "./sync.ts";

export interface SnapshotOptions {
	reason: string;
	trigger?: string;
	sessionId?: string;
	commitMessage?: string;
}

export interface SnapshotResult {
	manifest: EvolutionManifest | null;
	commit: GitCommitResult | null;
	skipped?: string;
}

export function createEvolutionSnapshot(config: EvolutionConfig, options: SnapshotOptions): SnapshotResult {
	if (!config.enabled) return { manifest: null, commit: null, skipped: "disabled" };
	ensureEvolutionRepo(config);
	const id = createSnapshotId();
	const snapshotDir = path.join(config.repoDir, "snapshots", id);
	emptyDir(path.join(snapshotDir, "memory"));
	emptyDir(path.join(snapshotDir, "skill-drafts"));
	copyDirContents(config.memoryDir, path.join(snapshotDir, "memory"));
	copyDirContents(config.skillDraftsDir, path.join(snapshotDir, "skill-drafts"));
	const manifest = buildManifest(config, id, options.reason, options.trigger || "manual", options.sessionId);
	writeManifest(config, manifest);
	syncCurrentToEvolution(config);
	const commit = commitEvolutionChanges(config, options.commitMessage || `memory: snapshot ${id}`);
	return { manifest, commit };
}

export function syncEvolutionAfterChange(config: EvolutionConfig, message: string): GitCommitResult | null {
	if (!config.enabled) return null;
	syncCurrentToEvolution(config);
	return commitEvolutionChanges(config, message);
}
