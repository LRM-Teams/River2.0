import * as path from "node:path";

export interface EvolutionConfig {
	enabled: boolean;
	autoCommit: boolean;
	autoPush: boolean;
	repoDir: string;
	remote: string;
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
		| "HOME"
		| "USERPROFILE"
		| "HOMEDRIVE"
		| "HOMEPATH",
		string | undefined
	>
>;

export const DEFAULT_EVOLUTION_REMOTE = "https://github.com/LRM-Teams/pi-evolution.git";
export const DEFAULT_EVOLUTION_BRANCH = "main";

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
		repoDir: path.resolve(expandHome(env.PI_EVOLUTION_DIR || path.join(agentDir, "evolution"), env)),
		remote: env.PI_EVOLUTION_REMOTE || DEFAULT_EVOLUTION_REMOTE,
		branch: env.PI_EVOLUTION_BRANCH || DEFAULT_EVOLUTION_BRANCH,
		memoryDir,
		skillDraftsDir: path.join(agentDir, "skill-drafts"),
	};
}
