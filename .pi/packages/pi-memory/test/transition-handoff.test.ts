import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildTransitionHandoff,
	getMemoryLearningMode,
	getMemorySkillDraftsMode,
	parseLearningExtractorResponse,
	shouldSkipExitSummaryForReason,
	shouldWriteTransitionHandoffForReason,
} from "../index.ts";

function message(role: "user" | "assistant", text: string) {
	return {
		type: "message" as const,
		message: {
			role,
			content: [{ type: "text" as const, text }],
			timestamp: 0,
		},
	};
}

function ctx(branch: ReturnType<typeof message>[]) {
	return {
		sessionManager: {
			getBranch: () => branch,
		},
	} as any;
}

test("writes lightweight handoffs only for new and fork transitions", () => {
	assert.equal(shouldSkipExitSummaryForReason("reload"), true);
	assert.equal(shouldSkipExitSummaryForReason("resume"), true);
	assert.equal(shouldSkipExitSummaryForReason("new"), true);
	assert.equal(shouldSkipExitSummaryForReason("fork"), true);

	assert.equal(shouldWriteTransitionHandoffForReason("reload"), false);
	assert.equal(shouldWriteTransitionHandoffForReason("resume"), false);
	assert.equal(shouldWriteTransitionHandoffForReason("new"), true);
	assert.equal(shouldWriteTransitionHandoffForReason("fork"), true);
});

test("memory learning defaults to review mode", () => {
	assert.equal(getMemoryLearningMode({}), "review");
	assert.equal(getMemoryLearningMode({ PI_MEMORY_LEARNING: "off" }), "off");
	assert.equal(getMemoryLearningMode({ PI_MEMORY_LEARNING: "auto-review" }), "auto-review");
	assert.equal(getMemorySkillDraftsMode({}), "review");
	assert.equal(getMemorySkillDraftsMode({ PI_MEMORY_SKILL_DRAFTS: "off" }), "off");
});

test("learning extractor response accepts only valid review candidates", () => {
	const candidates = parseLearningExtractorResponse(JSON.stringify({
		candidates: [
			{ kind: "preference", confidence: "medium", signature: "User prefers concise answers", targetHints: ["memory", "workflow"] },
			{ kind: "workflow", confidence: "high", signature: "workflow artifact" },
			{ kind: "project_fact", confidence: "low", signature: "low confidence fact" },
		],
	}));

	assert.deepEqual(candidates, [{
		kind: "preference",
		confidence: "medium",
		signature: "User prefers concise answers",
		summary: undefined,
		targetHints: ["memory"],
		evidence: undefined,
		source: "session_shutdown",
	}]);
});

test("buildTransitionHandoff captures recent conversation without LLM summary", () => {
	const handoff = buildTransitionHandoff(
		ctx([
			message("user", "Please investigate the memory shutdown behavior."),
			message("assistant", "I found that /reload and /resume should stay silent."),
		]),
		"new",
		"abcdef12",
		"2026-06-10 02:00:00",
	);

	assert.ok(handoff);
	assert.match(handoff, /Session Handoff \(auto, transition: \/new\)/);
	assert.match(handoff, /Please investigate the memory shutdown behavior/);
	assert.match(handoff, /reload and \/resume should stay silent/);
});
