import * as path from "node:path";
import type { EvolutionConfig } from "./config.ts";
import { copyDirContents, emptyDir } from "./file-utils.ts";
import { ensureEvolutionRepo } from "./git.ts";

function excludeRepoMetadata(relativePath: string): boolean {
	const normalized = relativePath.replace(/\\/g, "/");
	return normalized === ".git" || normalized.startsWith(".git/");
}

export function syncCurrentToEvolution(config: EvolutionConfig): void {
	if (!config.enabled) return;
	ensureEvolutionRepo(config);
	const memoryMirror = path.join(config.repoDir, "memory");
	const skillDraftsMirror = path.join(config.repoDir, "skill-drafts");
	emptyDir(memoryMirror);
	emptyDir(skillDraftsMirror);
	copyDirContents(config.memoryDir, memoryMirror, { exclude: excludeRepoMetadata });
	copyDirContents(config.skillDraftsDir, skillDraftsMirror, { exclude: excludeRepoMetadata });
}
