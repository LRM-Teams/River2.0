import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { resolveAgentRoots, type PiAgentEnv } from "../paths/resolve-roots.ts";
import { detectSensitivity, redactLocalPaths } from "./sensitivity.ts";
import type { EvolutionCandidate } from "./schemas.ts";
import { hashSkillBundle, loadSkillBundle, writeSkillBundle } from "./skill-bundle.ts";

export function appendEvolutionCandidate(input: Omit<EvolutionCandidate, "workspace_id" | "agent_id" | "local_unit_id" | "signature" | "created_at"> & Partial<Pick<EvolutionCandidate, "workspace_id" | "agent_id" | "local_unit_id" | "signature" | "created_at">>, env: PiAgentEnv = process.env): { path: string; candidate: EvolutionCandidate; appended: boolean } {
	const roots = resolveAgentRoots(env);
	if (!roots.syncQueueDir) throw new Error("sync queue requires PI_AGENT_ROOT or Multica agent env");
	const workspaceId = input.workspace_id || roots.workspaceId;
	const agentId = input.agent_id || roots.agentId;
	if (!workspaceId || !agentId) throw new Error("candidate requires workspace_id and agent_id");

	const skillBundle = input.type === "skill" && input.source_path ? loadSkillBundle(input.source_path) : null;
	const rawContent = skillBundle?.content ?? input.content;
	const allSkillContent = skillBundle ? [skillBundle.content, ...skillBundle.files.map((file) => file.content)].join("\n") : rawContent;
	const sensitivity = input.sensitivity || detectSensitivity(allSkillContent);
	if (sensitivity === "secret") throw new Error("secret-like content cannot enter sync_queue");
	const content = sensitivity === "local_path" ? redactLocalPaths(rawContent) : rawContent;
	const files = sensitivity === "local_path"
		? skillBundle?.files.map((file) => ({ ...file, content: redactLocalPaths(file.content) }))
		: skillBundle?.files;
	const signature = input.signature || stableHash([input.type, content, files?.map((file) => `${file.path}\0${file.content}`).join("\0") || "", input.tags.join(",")].join("\n"));
	const localUnitId = input.local_unit_id || `${input.type}_${signature.slice(0, 12)}`;
	const candidate: EvolutionCandidate = {
		...input,
		workspace_id: workspaceId,
		agent_id: agentId,
		local_unit_id: localUnitId,
		signature,
		content,
		sensitivity,
		created_at: input.created_at || new Date().toISOString(),
	};
	if (skillBundle) {
		const bundleDir = join(roots.syncQueueDir, "skill-candidates", localUnitId);
		const written = writeSkillBundle(bundleDir, content, files || []);
		candidate.name = skillBundle.name;
		candidate.description = skillBundle.description;
		candidate.provider = skillBundle.provider;
		candidate.content_hash = hashSkillBundle(content, files || []);
		candidate.files = files || [];
		candidate.bundle_path = relative(roots.syncQueueDir, bundleDir).replace(/\\/g, "/");
		candidate.source_path = candidate.bundle_path;
		writeCandidateManifest(join(bundleDir, "candidate.json"), candidate);
		if (written.length === 0) throw new Error("skill bundle was not written");
	}
	const filePath = join(roots.syncQueueDir, input.type === "skill" ? "skill-candidates.jsonl" : "memory-candidates.jsonl");
	mkdirSync(roots.syncQueueDir, { recursive: true });
	if (existsSync(filePath)) {
		const exists = readFileSync(filePath, "utf-8").split("\n").some((line: string) => line.includes(`\"local_unit_id\":\"${candidate.local_unit_id}\"`));
		if (exists) return { path: filePath, candidate, appended: false };
	}
	appendFileSync(filePath, `${JSON.stringify(candidate)}\n`, "utf-8");
	return { path: filePath, candidate, appended: true };
}

function writeCandidateManifest(filePath: string, candidate: EvolutionCandidate): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf-8");
}

function stableHash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
