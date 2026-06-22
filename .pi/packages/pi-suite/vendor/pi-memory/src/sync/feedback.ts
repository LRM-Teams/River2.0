import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveAgentRoots, type PiAgentEnv } from "../paths/resolve-roots.ts";
import { detectSensitivity } from "./sensitivity.ts";
import type { FeedbackEvent } from "./schemas.ts";

export function appendFeedbackEvent(event: FeedbackEvent, env: PiAgentEnv = process.env): string {
	const roots = resolveAgentRoots(env);
	if (!roots.feedbackDir) throw new Error("feedback directory requires PI_AGENT_ROOT or Multica agent env");
	const serialized = JSON.stringify(event);
	if (detectSensitivity(serialized) === "secret") throw new Error("feedback event appears to contain a secret");
	const filePath = join(roots.feedbackDir, "feedback.jsonl");
	mkdirSync(dirname(filePath), { recursive: true });
	appendFileSync(filePath, `${serialized}\n`, "utf-8");
	return filePath;
}

export function buildFeedbackEvent(input: Omit<FeedbackEvent, "workspace_id" | "agent_id" | "run_id" | "timestamp"> & Partial<Pick<FeedbackEvent, "workspace_id" | "agent_id" | "run_id" | "timestamp">>, env: PiAgentEnv = process.env): FeedbackEvent {
	const roots = resolveAgentRoots(env);
	const workspaceId = input.workspace_id || roots.workspaceId;
	const agentId = input.agent_id || roots.agentId;
	if (!workspaceId || !agentId) throw new Error("feedback event requires workspace_id and agent_id");
	return {
		...input,
		workspace_id: workspaceId,
		agent_id: agentId,
		run_id: input.run_id || env.MULTICA_RUN_ID,
		timestamp: input.timestamp || new Date().toISOString(),
	};
}
