import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveAgentRoots, type PiAgentEnv } from "../paths/resolve-roots.ts";
import { detectSensitivity, redactLocalPaths } from "./sensitivity.ts";
import type { EvolutionCandidate } from "./schemas.ts";

export function appendEvolutionCandidate(input: Omit<EvolutionCandidate, "workspace_id" | "agent_id" | "local_unit_id" | "signature" | "created_at"> & Partial<Pick<EvolutionCandidate, "workspace_id" | "agent_id" | "local_unit_id" | "signature" | "created_at">>, env: PiAgentEnv = process.env): { path: string; candidate: EvolutionCandidate; appended: boolean } {
	const roots = resolveAgentRoots(env);
	if (!roots.syncQueueDir) throw new Error("sync queue requires PI_AGENT_ROOT or Multica agent env");
	const workspaceId = input.workspace_id || roots.workspaceId;
	const agentId = input.agent_id || roots.agentId;
	if (!workspaceId || !agentId) throw new Error("candidate requires workspace_id and agent_id");
	const sensitivity = input.sensitivity || detectSensitivity(input.content);
	if (sensitivity === "secret") throw new Error("secret-like content cannot enter sync_queue");
	const content = sensitivity === "local_path" ? redactLocalPaths(input.content) : input.content;
	const signature = input.signature || stableHash([input.type, content, input.tags.join(",")].join("\n"));
	const candidate: EvolutionCandidate = {
		...input,
		workspace_id: workspaceId,
		agent_id: agentId,
		local_unit_id: input.local_unit_id || `${input.type}_${signature.slice(0, 12)}`,
		signature,
		content,
		sensitivity,
		created_at: input.created_at || new Date().toISOString(),
	};
	const filePath = join(roots.syncQueueDir, input.type === "skill" ? "skill-candidates.jsonl" : "memory-candidates.jsonl");
	mkdirSync(roots.syncQueueDir, { recursive: true });
	if (existsSync(filePath)) {
		const exists = readFileSync(filePath, "utf-8").split("\n").some((line) => line.includes(`\"local_unit_id\":\"${candidate.local_unit_id}\"`));
		if (exists) return { path: filePath, candidate, appended: false };
	}
	appendFileSync(filePath, `${JSON.stringify(candidate)}\n`, "utf-8");
	return { path: filePath, candidate, appended: true };
}

function stableHash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
