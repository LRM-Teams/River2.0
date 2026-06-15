import * as path from "node:path";

export interface EvolutionConfig {
	enabled: boolean;
	autoCommit: boolean;
	autoPush: boolean;
	maxSnapshots: number;
	repoDir: string;
	remote: string | null;
	branch: string;
	memoryDir: string;
	skillDraftsDir: string;
}

type EvolutionEnv = Partial<
	Record<
		| "PI_EVOLUTION_DIR"
		| "PI_EVOLUTION_REMOTE"
		| "PI_EVOLUTION_BRANCH"
		| "PI_EVOLUTION_ENABLED"
		| "PI_EVOLUTION_AUTO_COMMIT"
		| "PI_EVOLUTION_AUTO_PUSH"
		| "PI_EVOLUTION_MAX_SNAPSHOTS"
		| "HOME"
		| "USERPROFILE"
		| "HOMEDRIVE"
		| "HOMEPATH",
		string | undefined
	>
>;

export const DEFAULT_EVOLUTION_REMOTE = "";
export const LEGACY_SHARED_EVOLUTION_REMOTE = "https://github.com/LRM-Teams/pi-evolution.git";
export const DEFAULT_EVOLUTION_BRANCH = "main";
export const DEFAULT_EVOLUTION_MAX_SNAPSHOTS = 100;

function homeDir(env: EvolutionEnv): string {
	return env.HOME ?? env.USERPROFILE ?? (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined) ?? "~";
}

function truthy(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function positiveInteger(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value.trim(), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function expandHome(input: string, env: EvolutionEnv): string {
	if (input === "~") return homeDir(env);
	if (input.startsWith("~/")) return path.join(homeDir(env), input.slice(2));
	return input;
}

export function resolveEvolutionConfig(memoryDir: string, env: EvolutionEnv = process.env): EvolutionConfig {
	const agentDir = path.dirname(memoryDir);
	return {
		enabled: truthy(env.PI_EVOLUTION_ENABLED, true),
		autoCommit: truthy(env.PI_EVOLUTION_AUTO_COMMIT, true),
		autoPush: truthy(env.PI_EVOLUTION_AUTO_PUSH, false),
		maxSnapshots: positiveInteger(env.PI_EVOLUTION_MAX_SNAPSHOTS, DEFAULT_EVOLUTION_MAX_SNAPSHOTS),
		repoDir: path.resolve(expandHome(env.PI_EVOLUTION_DIR || path.join(agentDir, "evolution"), env)),
		remote: env.PI_EVOLUTION_REMOTE?.trim() || null,
		branch: env.PI_EVOLUTION_BRANCH || DEFAULT_EVOLUTION_BRANCH,
		memoryDir,
		skillDraftsDir: path.join(agentDir, "skill-drafts"),
	};
}
