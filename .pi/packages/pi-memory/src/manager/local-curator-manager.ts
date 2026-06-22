import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JsonlAuditLog } from "../curator-core/audit.ts";
import { runMemoryCuratorOnce } from "../curator-core/curate.ts";
import { FileMemoryStore } from "../curator-store/file-store.ts";
import { applyReviewLifecycle, proposeMemoryPromotions } from "../learning/memory.ts";
import { proposeSkillDrafts } from "../learning/skills.ts";
import { ensureAgentRoot, resolveAgentRoots, type PiAgentEnv } from "../paths/resolve-roots.ts";
import { generateShareCandidatesFromReview } from "../governance/share-candidates.ts";
import { generateProfiles } from "../profile/generator.ts";

export type CuratorRootRecord = {
	workspace_id?: string;
	agent_id?: string;
	agent_root: string;
	memory_dir: string;
	skill_dir: string;
	dirty_since?: string;
	last_curated_at?: string;
	last_synced_at?: string;
	status: "idle" | "dirty" | "running" | "error";
	last_error?: string;
};

export type CuratorRegistry = {
	roots: CuratorRootRecord[];
};

export function defaultRegistryPath(env: PiAgentEnv = process.env): string {
	const roots = resolveAgentRoots(env);
	if (env.MULTICA_WORKSPACES_ROOT) return join(env.MULTICA_WORKSPACES_ROOT, ".pi-curator", "registry.json");
	if (roots.agentRoot) return join(dirname(dirname(dirname(dirname(roots.agentRoot)))), ".pi-curator", "registry.json");
	return join(env.HOME || process.cwd(), ".pi", "agent", "memory-curator-manager", "registry.json");
}

export function markCurrentRootDirty(env: PiAgentEnv = process.env, registryPath = defaultRegistryPath(env)): CuratorRootRecord {
	const roots = ensureAgentRoot(env);
	if (!roots.agentRoot) throw new Error("dirty root tracking requires PI_AGENT_ROOT or Multica agent env");
	const registry = readRegistry(registryPath);
	const existing = registry.roots.find((entry) => entry.agent_root === roots.agentRoot);
	const now = new Date().toISOString();
	const record: CuratorRootRecord = {
		workspace_id: roots.workspaceId,
		agent_id: roots.agentId,
		agent_root: roots.agentRoot,
		memory_dir: roots.memoryDir,
		skill_dir: roots.skillsDir,
		dirty_since: existing?.dirty_since || now,
		last_curated_at: existing?.last_curated_at,
		last_synced_at: existing?.last_synced_at,
		status: "dirty",
	};
	const next = registry.roots.filter((entry) => entry.agent_root !== roots.agentRoot);
	next.push(record);
	writeRegistry(registryPath, { roots: next });
	return record;
}

export async function scanDirtyRoots(registryPath: string): Promise<{ processed: number; failures: number }> {
	const managerLockPath = join(dirname(registryPath), ".manager-scan.lock");
	if (!acquireLock(managerLockPath, 6 * 60 * 60 * 1000)) throw new Error(`curator manager lock exists for ${registryPath}`);
	try {
		const registry = readRegistry(registryPath);
		let processed = 0;
		let failures = 0;
		for (const root of registry.roots) {
			if (root.status !== "dirty" && !root.dirty_since) continue;
			try {
				await curateRoot(root);
				root.status = "idle";
				root.dirty_since = undefined;
				root.last_curated_at = new Date().toISOString();
				root.last_error = undefined;
				processed += 1;
			} catch (error) {
				root.status = "error";
				root.last_error = error instanceof Error ? error.message : String(error);
				failures += 1;
			}
		}
		writeRegistry(registryPath, registry);
		return { processed, failures };
	} finally {
		releaseLock(managerLockPath);
	}
}

async function curateRoot(root: CuratorRootRecord): Promise<void> {
	const lockPath = join(root.agent_root, ".curator.lock");
	mkdirSync(root.agent_root, { recursive: true });
	if (!acquireLock(lockPath, 24 * 60 * 60 * 1000)) throw new Error(`curator lock exists for ${root.agent_root}`);
	try {
		const store = new FileMemoryStore(root.memory_dir);
		await runMemoryCuratorOnce({ memoryStore: store, auditLog: new JsonlAuditLog(root.memory_dir), reason: "local-curator-manager" });
		await applyReviewLifecycle(store);
		await proposeMemoryPromotions(store);
		await proposeSkillDrafts(store, { draftsDir: join(root.skill_dir, "drafts") });
		const env = { PI_AGENT_ROOT: root.agent_root, MULTICA_WORKSPACE_ID: root.workspace_id, MULTICA_AGENT_ID: root.agent_id };
		await generateShareCandidatesFromReview(store, env);
		generateProfiles(env);
	} finally {
		try {
			renameSync(lockPath, `${lockPath}.last`);
		} catch {
			releaseLock(lockPath);
		}
	}
}

function acquireLock(lockPath: string, staleAfterMs: number): boolean {
	mkdirSync(dirname(lockPath), { recursive: true });
	if (existsSync(lockPath)) {
		try {
			const age = Date.now() - statSync(lockPath).mtimeMs;
			if (age > staleAfterMs) rmSync(lockPath, { force: true });
			else return false;
		} catch {
			return false;
		}
	}
	writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, { encoding: "utf-8", flag: "wx" });
	return true;
}

function releaseLock(lockPath: string): void {
	try {
		rmSync(lockPath, { force: true });
	} catch {
		// best effort cleanup
	}
}

function readRegistry(registryPath: string): CuratorRegistry {
	if (!existsSync(registryPath)) return { roots: [] };
	try {
		const parsed = JSON.parse(readFileSync(registryPath, "utf-8")) as CuratorRegistry;
		return { roots: Array.isArray(parsed.roots) ? parsed.roots : [] };
	} catch {
		return { roots: [] };
	}
}

function writeRegistry(registryPath: string, registry: CuratorRegistry): void {
	mkdirSync(dirname(registryPath), { recursive: true });
	writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
}
