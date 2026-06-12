import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { LEGACY_SHARED_EVOLUTION_REMOTE, type EvolutionConfig } from "./config.ts";
import { pathExists } from "./file-utils.ts";

export interface GitStatus {
	repoDir: string;
	initialized: boolean;
	branch: string | null;
	remote: string | null;
	dirty: boolean;
	status: string;
	lastCommit: string | null;
	autoPush: boolean;
	autoCommit: boolean;
	enabled: boolean;
}

export interface GitCommitResult {
	committed: boolean;
	commit?: string;
	message?: string;
	status: string;
}

function runGit(repoDir: string, args: string[], options: { allowFailure?: boolean } = {}): string {
	try {
		return execFileSync("git", args, { cwd: repoDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (error) {
		if (options.allowFailure) return "";
		throw error;
	}
}

function isGitRepo(repoDir: string): boolean {
	return pathExists(path.join(repoDir, ".git"));
}

function isEmptyDir(repoDir: string): boolean {
	if (!pathExists(repoDir)) return true;
	return fs.readdirSync(repoDir).length === 0;
}

function ensureGitIdentity(repoDir: string): void {
	const name = runGit(repoDir, ["config", "user.name"], { allowFailure: true });
	const email = runGit(repoDir, ["config", "user.email"], { allowFailure: true });
	if (!name) runGit(repoDir, ["config", "user.name", "pi-memory"]);
	if (!email) runGit(repoDir, ["config", "user.email", "pi-memory@local"]);
}

export function ensureEvolutionRepo(config: EvolutionConfig): void {
	if (!config.enabled) return;
	if (pathExists(config.repoDir) && !isGitRepo(config.repoDir) && !isEmptyDir(config.repoDir)) {
		throw new Error(`Evolution directory exists but is not a git repo: ${config.repoDir}`);
	}
	if (!pathExists(config.repoDir)) {
		fs.mkdirSync(path.dirname(config.repoDir), { recursive: true });
		if (config.remote) {
			try {
				execFileSync("git", ["clone", "--branch", config.branch, config.remote, config.repoDir], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
			} catch {
				fs.mkdirSync(config.repoDir, { recursive: true });
				runGit(config.repoDir, ["init", "-b", config.branch], { allowFailure: true });
				if (!isGitRepo(config.repoDir)) runGit(config.repoDir, ["init"]);
				runGit(config.repoDir, ["checkout", "-B", config.branch]);
				runGit(config.repoDir, ["remote", "add", "origin", config.remote], { allowFailure: true });
			}
		} else {
			fs.mkdirSync(config.repoDir, { recursive: true });
			runGit(config.repoDir, ["init", "-b", config.branch], { allowFailure: true });
			if (!isGitRepo(config.repoDir)) runGit(config.repoDir, ["init"]);
			runGit(config.repoDir, ["checkout", "-B", config.branch]);
		}
	} else if (!isGitRepo(config.repoDir)) {
		fs.mkdirSync(config.repoDir, { recursive: true });
		runGit(config.repoDir, ["init", "-b", config.branch], { allowFailure: true });
		if (!isGitRepo(config.repoDir)) runGit(config.repoDir, ["init"]);
		runGit(config.repoDir, ["checkout", "-B", config.branch]);
	}

	const remote = runGit(config.repoDir, ["remote", "get-url", "origin"], { allowFailure: true });
	if (config.remote) {
		if (!remote) runGit(config.repoDir, ["remote", "add", "origin", config.remote]);
		else if (remote !== config.remote) runGit(config.repoDir, ["remote", "set-url", "origin", config.remote]);
	} else if (remote === LEGACY_SHARED_EVOLUTION_REMOTE) {
		runGit(config.repoDir, ["remote", "remove", "origin"], { allowFailure: true });
	}

	const branch = runGit(config.repoDir, ["branch", "--show-current"], { allowFailure: true });
	if (!branch) runGit(config.repoDir, ["checkout", "-B", config.branch]);
	ensureGitIdentity(config.repoDir);
}

export function getEvolutionGitStatus(config: EvolutionConfig): GitStatus {
	if (!config.enabled || !isGitRepo(config.repoDir)) {
		return {
			repoDir: config.repoDir,
			initialized: isGitRepo(config.repoDir),
			branch: null,
			remote: null,
			dirty: false,
			status: "",
			lastCommit: null,
			autoPush: config.autoPush,
			autoCommit: config.autoCommit,
			enabled: config.enabled,
		};
	}
	const status = runGit(config.repoDir, ["status", "--short"], { allowFailure: true });
	return {
		repoDir: config.repoDir,
		initialized: true,
		branch: runGit(config.repoDir, ["branch", "--show-current"], { allowFailure: true }) || null,
		remote: runGit(config.repoDir, ["remote", "get-url", "origin"], { allowFailure: true }) || null,
		dirty: Boolean(status),
		status,
		lastCommit: runGit(config.repoDir, ["log", "-1", "--oneline"], { allowFailure: true }) || null,
		autoPush: config.autoPush,
		autoCommit: config.autoCommit,
		enabled: config.enabled,
	};
}

export function commitEvolutionChanges(config: EvolutionConfig, message: string): GitCommitResult {
	ensureEvolutionRepo(config);
	if (!config.autoCommit) {
		const status = runGit(config.repoDir, ["status", "--short"], { allowFailure: true });
		return { committed: false, message: "auto commit disabled", status };
	}
	runGit(config.repoDir, ["add", "memory", "skill-drafts", "snapshots", "manifests"]);
	const status = runGit(config.repoDir, ["status", "--short"], { allowFailure: true });
	if (!status) return { committed: false, status };
	runGit(config.repoDir, ["commit", "-m", message]);
	const commit = runGit(config.repoDir, ["rev-parse", "--short", "HEAD"], { allowFailure: true }) || undefined;
	return { committed: true, commit, status };
}

export function pushEvolution(config: EvolutionConfig): string {
	ensureEvolutionRepo(config);
	const remote = runGit(config.repoDir, ["remote", "get-url", "origin"], { allowFailure: true });
	if (!remote) {
		return "No evolution remote configured. Add a personal private remote with `git -C ~/.pi/agent/evolution remote add origin <url>` or set PI_EVOLUTION_REMOTE before setup.";
	}
	const branch = runGit(config.repoDir, ["branch", "--show-current"], { allowFailure: true }) || config.branch;
	return runGit(config.repoDir, ["push", "-u", "origin", branch]);
}
