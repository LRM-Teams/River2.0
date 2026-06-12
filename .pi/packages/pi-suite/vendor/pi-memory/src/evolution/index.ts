export { DEFAULT_EVOLUTION_BRANCH, DEFAULT_EVOLUTION_REMOTE, resolveEvolutionConfig, type EvolutionConfig } from "./config.ts";
export { commitEvolutionChanges, ensureEvolutionRepo, getEvolutionGitStatus, pushEvolution, type GitCommitResult, type GitStatus } from "./git.ts";
export { buildManifest, createSnapshotId, listManifests, readManifest, writeManifest, type EvolutionManifest } from "./manifest.ts";
export { restoreEvolutionSnapshot, type RestoreResult, type RestoreTarget } from "./restore.ts";
export { createEvolutionSnapshot, syncEvolutionAfterChange, type SnapshotOptions, type SnapshotResult } from "./snapshot.ts";
export { syncCurrentToEvolution } from "./sync.ts";
