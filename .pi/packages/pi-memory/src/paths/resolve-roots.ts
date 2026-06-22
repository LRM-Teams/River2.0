import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type PiAgentEnv = Partial<
	Record<
		| "PI_AGENT_ROOT"
		| "PI_MEMORY_DIR"
		| "PI_SKILL_DRAFTS_DIR"
		| "PI_AGENT_INBOX_DIR"
		| "PI_AGENT_SHARED_CACHE_DIR"
		| "PI_AGENT_PROFILE_DIR"
		| "PI_AGENT_FEEDBACK_DIR"
		| "PI_AGENT_SYNC_QUEUE_DIR"
		| "MULTICA_WORKSPACES_ROOT"
		| "MULTICA_WORKSPACE_ID"
		| "MULTICA_AGENT_ID"
		| "MULTICA_RUN_ID"
		| "HOME"
		| "USERPROFILE"
		| "HOMEDRIVE"
		| "HOMEPATH",
		string | undefined
	>
>;

export type ResolvedAgentRoots = {
	agentRoot?: string;
	memoryDir: string;
	skillDraftsDir: string;
	skillsDir: string;
	inboxDir?: string;
	sharedCacheDir?: string;
	profileDir?: string;
	feedbackDir?: string;
	syncQueueDir?: string;
	workspaceId?: string;
	agentId?: string;
};

function homeDir(env: PiAgentEnv): string {
	return env.HOME ?? env.USERPROFILE ?? (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined) ?? "~";
}

function expandHome(input: string, env: PiAgentEnv): string {
	if (input === "~") return homeDir(env);
	if (input.startsWith("~/")) return join(homeDir(env), input.slice(2));
	return input;
}

function cleanSegment(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed.replace(/[\\/\0]/g, "-");
}

export function resolveAgentRoot(env: PiAgentEnv = process.env): string | undefined {
	if (env.PI_AGENT_ROOT?.trim()) return resolve(expandHome(env.PI_AGENT_ROOT.trim(), env));
	const workspaceId = cleanSegment(env.MULTICA_WORKSPACE_ID);
	const agentId = cleanSegment(env.MULTICA_AGENT_ID);
	if (!workspaceId || !agentId) return undefined;
	const workspacesRoot = resolve(expandHome(env.MULTICA_WORKSPACES_ROOT || "~/multica_workspaces", env));
	return join(workspacesRoot, workspaceId, ".pi", "agents", agentId);
}

export function resolveMemoryRoot(env: PiAgentEnv = process.env): string {
	if (env.PI_MEMORY_DIR?.trim()) return resolve(expandHome(env.PI_MEMORY_DIR.trim(), env));
	const agentRoot = resolveAgentRoot(env);
	if (agentRoot) return join(agentRoot, "memory");
	return join(homeDir(env), ".pi", "agent", "memory");
}

export function resolveSkillDraftRoot(env: PiAgentEnv = process.env): string {
	if (env.PI_SKILL_DRAFTS_DIR?.trim()) return resolve(expandHome(env.PI_SKILL_DRAFTS_DIR.trim(), env));
	const agentRoot = resolveAgentRoot(env);
	if (agentRoot) return join(agentRoot, "skills", "drafts");
	return join(homeDir(env), ".pi", "agent", "skill-drafts");
}

function resolveAgentSubdir(envName: keyof PiAgentEnv, fallbackName: string, env: PiAgentEnv): string | undefined {
	const explicit = env[envName];
	if (explicit?.trim()) return resolve(expandHome(explicit.trim(), env));
	const agentRoot = resolveAgentRoot(env);
	return agentRoot ? join(agentRoot, fallbackName) : undefined;
}

export function resolveInboxDir(env: PiAgentEnv = process.env): string | undefined {
	return resolveAgentSubdir("PI_AGENT_INBOX_DIR", "inbox", env);
}

export function resolveSharedCacheDir(env: PiAgentEnv = process.env): string | undefined {
	return resolveAgentSubdir("PI_AGENT_SHARED_CACHE_DIR", "shared-cache", env);
}

export function resolveProfileDir(env: PiAgentEnv = process.env): string | undefined {
	return resolveAgentSubdir("PI_AGENT_PROFILE_DIR", "profile", env);
}

export function resolveFeedbackDir(env: PiAgentEnv = process.env): string | undefined {
	return resolveAgentSubdir("PI_AGENT_FEEDBACK_DIR", "feedback", env);
}

export function resolveSyncQueueDir(env: PiAgentEnv = process.env): string | undefined {
	return resolveAgentSubdir("PI_AGENT_SYNC_QUEUE_DIR", "sync_queue", env);
}

export function resolveAgentRoots(env: PiAgentEnv = process.env): ResolvedAgentRoots {
	const agentRoot = resolveAgentRoot(env);
	const memoryDir = resolveMemoryRoot(env);
	const skillDraftsDir = resolveSkillDraftRoot(env);
	return {
		agentRoot,
		memoryDir,
		skillDraftsDir,
		skillsDir: agentRoot ? join(agentRoot, "skills") : dirname(skillDraftsDir),
		inboxDir: resolveInboxDir(env),
		sharedCacheDir: resolveSharedCacheDir(env),
		profileDir: resolveProfileDir(env),
		feedbackDir: resolveFeedbackDir(env),
		syncQueueDir: resolveSyncQueueDir(env),
		workspaceId: cleanSegment(env.MULTICA_WORKSPACE_ID),
		agentId: cleanSegment(env.MULTICA_AGENT_ID),
	};
}

function ensureFile(filePath: string, content = ""): void {
	if (existsSync(filePath)) return;
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, "utf-8");
}

export function ensureAgentRoot(rootOrEnv: string | PiAgentEnv = process.env): ResolvedAgentRoots {
	const roots = typeof rootOrEnv === "string" ? resolveAgentRoots({ ...process.env, PI_AGENT_ROOT: rootOrEnv }) : resolveAgentRoots(rootOrEnv);
	mkdirSync(roots.memoryDir, { recursive: true });
	mkdirSync(join(roots.memoryDir, "daily"), { recursive: true });
	mkdirSync(join(roots.memoryDir, "audit"), { recursive: true });
	for (const name of ["MEMORY.md", "USER.md", "STATE.md", "REVIEW.md"]) ensureFile(join(roots.memoryDir, name));
	ensureFile(join(roots.memoryDir, "SCRATCHPAD.md"), "# Scratchpad\n");
	ensureFile(join(roots.memoryDir, ".curator-state.json"), "{}\n");
	mkdirSync(roots.skillDraftsDir, { recursive: true });

	if (roots.agentRoot) {
		mkdirSync(join(roots.agentRoot, "skills", "generated"), { recursive: true });
		mkdirSync(join(roots.agentRoot, "skills", "enabled"), { recursive: true });
		mkdirSync(join(roots.agentRoot, "inbox", "memory"), { recursive: true });
		mkdirSync(join(roots.agentRoot, "inbox", "skills"), { recursive: true });
		mkdirSync(join(roots.agentRoot, "shared-cache", "memory"), { recursive: true });
		mkdirSync(join(roots.agentRoot, "shared-cache", "skills"), { recursive: true });
		mkdirSync(join(roots.agentRoot, "profile"), { recursive: true });
		mkdirSync(join(roots.agentRoot, "sync_queue"), { recursive: true });
		mkdirSync(join(roots.agentRoot, "feedback"), { recursive: true });
		ensureFile(join(roots.agentRoot, "feedback", "feedback.jsonl"));
	}

	return roots;
}
