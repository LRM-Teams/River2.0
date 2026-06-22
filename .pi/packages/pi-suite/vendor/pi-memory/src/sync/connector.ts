import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveAgentRoots, type PiAgentEnv } from "../paths/resolve-roots.ts";
import { receiveDelivery } from "./downflow.ts";
import { detectSensitivity } from "./sensitivity.ts";
import type { Delivery } from "./schemas.ts";

export type SyncUploadResult = {
	ok: boolean;
	skipped?: string;
	candidates: number;
	feedback: number;
	profiles: number;
};

export type SyncPullResult = {
	ok: boolean;
	skipped?: string;
	received: number;
	rejected: number;
	written: string[];
};

type UploadCheckpoint = {
	uploaded_at?: string;
	uploadedCandidateIds?: string[];
	feedbackLineCount?: number;
	profiles?: number;
};

export async function syncUpload(env: PiAgentEnv & Record<string, string | undefined> = process.env): Promise<SyncUploadResult> {
	const baseUrl = env.PI_MEMORY_REMOTE_URL?.replace(/\/+$/, "");
	const token = env.PI_MEMORY_REMOTE_TOKEN;
	if (!baseUrl || !token) return { ok: true, skipped: "PI_MEMORY_REMOTE_URL or PI_MEMORY_REMOTE_TOKEN not configured", candidates: 0, feedback: 0, profiles: 0 };
	const roots = resolveAgentRoots(env);
	if (!roots.syncQueueDir || !roots.feedbackDir || !roots.profileDir || !roots.agentId) throw new Error("memory sync upload requires PI_AGENT_ROOT or Multica agent env");
	const checkpointPath = join(roots.syncQueueDir, ".upload-checkpoint.json");
	const checkpoint = readCheckpoint(checkpointPath);
	const uploadedIds = new Set(checkpoint.uploadedCandidateIds || []);
	const memoryCandidates = readJsonl(join(roots.syncQueueDir, "memory-candidates.jsonl"));
	const skillCandidates = readJsonl(join(roots.syncQueueDir, "skill-candidates.jsonl"));
	const candidates = [...memoryCandidates, ...skillCandidates]
		.filter((entry) => detectSensitivity(JSON.stringify(entry)) !== "secret")
		.filter((entry) => !uploadedIds.has(candidateId(entry)));
	const feedbackLines = readJsonlWithCount(join(roots.feedbackDir, "feedback.jsonl"));
	const feedback = feedbackLines.entries
		.slice(checkpoint.feedbackLineCount || 0)
		.filter((entry) => detectSensitivity(JSON.stringify(entry)) !== "secret");
	const profiles = readProfiles(roots.profileDir);
	if (candidates.length > 0) await postJson(`${baseUrl}/api/evolution/submissions`, { candidates }, token);
	if (Object.keys(profiles).length > 0) await postJson(`${baseUrl}/api/agents/${encodeURIComponent(roots.agentId)}/evolution-profile`, { profiles }, token);
	if (feedback.length > 0) await postJson(`${baseUrl}/api/evolution/feedback`, { feedback }, token);
	const nextUploadedIds = [...uploadedIds, ...candidates.map(candidateId).filter(Boolean)];
	writeCheckpoint(checkpointPath, {
		uploaded_at: new Date().toISOString(),
		uploadedCandidateIds: [...new Set(nextUploadedIds)],
		feedbackLineCount: feedbackLines.lineCount,
		profiles: Object.keys(profiles).length,
	});
	return { ok: true, candidates: candidates.length, feedback: feedback.length, profiles: Object.keys(profiles).length };
}

export async function syncPull(env: PiAgentEnv & Record<string, string | undefined> = process.env, limit = 20): Promise<SyncPullResult> {
	const baseUrl = env.PI_MEMORY_REMOTE_URL?.replace(/\/+$/, "");
	const token = env.PI_MEMORY_REMOTE_TOKEN;
	const roots = resolveAgentRoots(env);
	if (!baseUrl || !token) return { ok: true, skipped: "PI_MEMORY_REMOTE_URL or PI_MEMORY_REMOTE_TOKEN not configured", received: 0, rejected: 0, written: [] };
	if (!roots.agentId) throw new Error("memory sync pull requires MULTICA_AGENT_ID or PI_AGENT_ROOT-derived agent context");
	const response = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(roots.agentId)}/evolution-deliveries?limit=${encodeURIComponent(String(limit))}`, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (!response.ok) throw new Error(`pull failed: HTTP ${response.status}`);
	const payload = await response.json() as { deliveries?: Delivery[] } | Delivery[];
	const deliveries = Array.isArray(payload) ? payload : payload.deliveries || [];
	let received = 0;
	let rejected = 0;
	const written: string[] = [];
	for (const delivery of deliveries) {
		const result = receiveDelivery(delivery, env);
		if (result.accepted) {
			received += 1;
			written.push(...result.written);
		} else {
			rejected += 1;
		}
	}
	return { ok: true, received, rejected, written };
}

function readJsonl(filePath: string): unknown[] {
	return readJsonlWithCount(filePath).entries;
}

function readJsonlWithCount(filePath: string): { entries: unknown[]; lineCount: number } {
	if (!existsSync(filePath)) return { entries: [], lineCount: 0 };
	const entries: unknown[] = [];
	let lineCount = 0;
	for (const line of readFileSync(filePath, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		lineCount += 1;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// Ignore malformed queue lines; curator/audit can surface them separately.
		}
	}
	return { entries, lineCount };
}

function readProfiles(profileDir: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name of ["user-profile.md", "agent-profile.md", "task-profile.md", "capability-profile.md"]) {
		const filePath = join(profileDir, name);
		if (existsSync(filePath)) result[name] = readFileSync(filePath, "utf-8");
	}
	return result;
}

function candidateId(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const record = value as { local_unit_id?: unknown; signature?: unknown };
	return typeof record.local_unit_id === "string" ? record.local_unit_id : typeof record.signature === "string" ? record.signature : "";
}

function readCheckpoint(filePath: string): UploadCheckpoint {
	if (!existsSync(filePath)) return {};
	try {
		return JSON.parse(readFileSync(filePath, "utf-8")) as UploadCheckpoint;
	} catch {
		return {};
	}
}

async function postJson(url: string, body: unknown, token: string): Promise<void> {
	const response = await fetch(url, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`upload failed: HTTP ${response.status}`);
}

function writeCheckpoint(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
