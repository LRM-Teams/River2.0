export type EvolutionUnitType = "memory" | "skill" | "workflow" | "tool_pattern" | "preference";
export type FeedbackEventType = "injected" | "used" | "ignored" | "success" | "failure" | "conflict";

export type SkillFileData = {
	path: string;
	content: string;
};

export type EvolutionCandidate = {
	type: EvolutionUnitType;
	workspace_id: string;
	agent_id: string;
	local_unit_id: string;
	signature: string;
	content: string;
	tags: string[];
	source: "local_curator" | "memory_review" | "manual";
	suggested_scope: "agent" | "workspace" | "project" | "team" | "global" | "agent_type";
	status: "candidate" | "uploaded" | "rejected";
	sensitivity?: "none" | "local_path" | "personal" | "secret" | "unknown";
	source_candidate_ids?: string[];
	created_at: string;
	name?: string;
	description?: string;
	source_path?: string;
	provider?: "pi";
	content_hash?: string;
	files?: SkillFileData[];
	bundle_path?: string;
};

export type FeedbackEvent = {
	shared_unit_id: string;
	unit_type: "memory" | "skill";
	workspace_id: string;
	agent_id: string;
	run_id?: string;
	task_type?: string;
	event: FeedbackEventType;
	outcome?: "success" | "failure" | "neutral";
	timestamp: string;
};

export type Delivery = {
	id: string;
	shared_unit_id: string;
	unit_type: "memory" | "skill";
	content: string;
	name?: string;
	description?: string;
	files?: SkillFileData[];
	source_path?: string;
	provider?: "pi";
	content_hash?: string;
	tags?: string[];
	score?: number;
	task_types?: string[];
	tools?: string[];
	project_types?: string[];
	required_tools?: string[];
	metadata?: Record<string, unknown>;
};
