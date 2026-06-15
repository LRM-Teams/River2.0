import * as fs from "node:fs";
import * as path from "node:path";
import type { EvolutionConfig } from "./config.ts";
import { countFiles, pathExists } from "./file-utils.ts";

export interface EvolutionManifest {
	id: string;
	createdAt: string;
	reason: string;
	trigger: string;
	memoryDir: string;
	skillDraftsDir: string;
	repoDir: string;
	sessionId?: string;
	files: {
		memory: number;
		skillDrafts: number;
	};
}

export function createSnapshotId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
	const suffix = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
	return `${stamp}-${suffix}`;
}

export function buildManifest(config: EvolutionConfig, id: string, reason: string, trigger: string, sessionId?: string, now = new Date()): EvolutionManifest {
	return {
		id,
		createdAt: now.toISOString(),
		reason,
		trigger,
		memoryDir: config.memoryDir,
		skillDraftsDir: config.skillDraftsDir,
		repoDir: config.repoDir,
		sessionId,
		files: {
			memory: countFiles(config.memoryDir),
			skillDrafts: countFiles(config.skillDraftsDir),
		},
	};
}

export function writeManifest(config: EvolutionConfig, manifest: EvolutionManifest): void {
	const snapshotDir = path.join(config.repoDir, "snapshots", manifest.id);
	const manifestsDir = path.join(config.repoDir, "manifests");
	fs.mkdirSync(snapshotDir, { recursive: true });
	fs.mkdirSync(manifestsDir, { recursive: true });
	const content = `${JSON.stringify(manifest, null, 2)}\n`;
	fs.writeFileSync(path.join(snapshotDir, "manifest.json"), content, "utf-8");
	fs.writeFileSync(path.join(manifestsDir, `${manifest.id}.json`), content, "utf-8");
}

export function readManifest(config: EvolutionConfig, id: string): EvolutionManifest {
	const filePath = path.join(config.repoDir, "manifests", `${id}.json`);
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as EvolutionManifest;
}

export function listManifests(config: EvolutionConfig, limit = 20): EvolutionManifest[] {
	return readAllManifests(config).slice(0, limit);
}

export function pruneOldSnapshots(config: EvolutionConfig): EvolutionManifest[] {
	const manifests = readAllManifests(config);
	if (manifests.length <= config.maxSnapshots) return [];

	const removed = manifests.slice(config.maxSnapshots);
	for (const manifest of removed) {
		fs.rmSync(path.join(config.repoDir, "snapshots", manifest.id), { recursive: true, force: true });
		fs.rmSync(path.join(config.repoDir, "manifests", `${manifest.id}.json`), { force: true });
	}
	return removed;
}

function readAllManifests(config: EvolutionConfig): EvolutionManifest[] {
	const dir = path.join(config.repoDir, "manifests");
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as EvolutionManifest)
		.filter((manifest) => pathExists(path.join(config.repoDir, "snapshots", manifest.id)))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
