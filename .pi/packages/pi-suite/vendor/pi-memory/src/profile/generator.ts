import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentRoots, type PiAgentEnv } from "../paths/resolve-roots.ts";
import { detectSensitivity, redactLocalPaths } from "../sync/sensitivity.ts";

export type ProfileGenerationResult = {
	written: string[];
};

export function generateProfiles(env: PiAgentEnv = process.env): ProfileGenerationResult {
	const roots = resolveAgentRoots(env);
	if (!roots.profileDir) throw new Error("profile generation requires PI_AGENT_ROOT or Multica agent env");
	mkdirSync(roots.profileDir, { recursive: true });
	const memory = readSafe(join(roots.memoryDir, "MEMORY.md"));
	const user = readSafe(join(roots.memoryDir, "USER.md"));
	const review = readSafe(join(roots.memoryDir, "REVIEW.md"));
	const profileInputs = redactLocalPaths([memory, user, review].filter(Boolean).join("\n\n"));
	const safeInputs = detectSensitivity(profileInputs) === "secret" ? "Secret-like content omitted from profile." : profileInputs;
	const written: string[] = [];
	written.push(writeProfile(roots.profileDir, "user-profile.md", ["# User Profile", excerpt(user || safeInputs)]));
	written.push(writeProfile(roots.profileDir, "agent-profile.md", ["# Agent Profile", `Workspace: ${roots.workspaceId || "standalone"}`, `Agent: ${roots.agentId || "standalone"}`]));
	written.push(writeProfile(roots.profileDir, "task-profile.md", ["# Task Profile", excerpt(review || memory)]));
	written.push(writeProfile(roots.profileDir, "capability-profile.md", ["# Capability Profile", "- Memory tools: available", "- Skill drafts: available", "- Multica scoped root: " + (roots.agentRoot ? "yes" : "no")]));
	return { written };
}

function readSafe(filePath: string): string {
	try {
		return readFileSync(filePath, "utf-8");
	} catch {
		return "";
	}
}

function excerpt(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "No stable evidence yet.";
	return trimmed.split("\n").filter(Boolean).slice(0, 80).join("\n");
}

function writeProfile(profileDir: string, name: string, lines: string[]): string {
	const filePath = join(profileDir, name);
	writeFileSync(filePath, `${lines.join("\n").trim()}\n`, "utf-8");
	return filePath;
}
