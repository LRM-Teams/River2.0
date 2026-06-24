import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildTransitionHandoff,
	extractStructuredToolEvidenceCandidates,
	getMemoryAutoSyncPullOnStart,
	getMemoryAutoSyncUploadOnShutdown,
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

function assistantToolCall(id: string, name: string, args: Record<string, unknown>) {
	return {
		type: "message" as const,
		message: {
			role: "assistant" as const,
			content: [{ type: "toolCall" as const, id, name, arguments: args }],
			timestamp: 0,
		},
	};
}

function toolResult(id: string, name: string, text: string, isError = false) {
	return {
		type: "message" as const,
		message: {
			role: "toolResult" as const,
			toolCallId: id,
			toolName: name,
			content: [{ type: "text" as const, text }],
			isError,
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
	assert.equal(getMemorySkillDraftsMode({}), "auto-draft");
	assert.equal(getMemorySkillDraftsMode({ PI_MEMORY_SKILL_DRAFTS: "review" }), "propose");
	assert.equal(getMemorySkillDraftsMode({ PI_MEMORY_SKILL_DRAFTS: "propose" }), "propose");
	assert.equal(getMemorySkillDraftsMode({ PI_MEMORY_SKILL_DRAFTS: "off" }), "off");
});

test("auto sync env flags are opt-in and support aliases", () => {
	assert.equal(getMemoryAutoSyncPullOnStart({}), false);
	assert.equal(getMemoryAutoSyncUploadOnShutdown({}), false);
	assert.equal(getMemoryAutoSyncPullOnStart({ PI_MEMORY_AUTO_SYNC: "1" }), true);
	assert.equal(getMemoryAutoSyncUploadOnShutdown({ PI_MEMORY_AUTO_SYNC: "1" }), true);
	assert.equal(getMemoryAutoSyncPullOnStart({ PI_MEMORY_AUTO_SYNC: "1", PI_MEMORY_AUTO_SYNC_PULL_ON_START: "0" }), false);
	assert.equal(getMemoryAutoSyncUploadOnShutdown({ PI_MEMORY_AUTO_SYNC_UPLOAD: "yes" }), true);
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

test("structured tool evidence creates high-confidence skill candidate", () => {
	const candidates = extractStructuredToolEvidenceCandidates([
		assistantToolCall("fail", "bash", { command: "npm run check" }),
		toolResult("fail", "bash", "Command exited with code 1\nError: shrinkwrap is out of date", false),
		assistantToolCall("edit", "edit", { path: "package-lock.json" }),
		toolResult("edit", "edit", "Successfully replaced 1 block", false),
		assistantToolCall("pass", "bash", { command: "npm run check" }),
		toolResult("pass", "bash", "OK", false),
	] as any, "tool_evidence");

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].kind, "skill_candidate");
	assert.equal(candidates[0].confidence, "high");
	assert.deepEqual(candidates[0].targetHints, ["skill"]);
	assert.match(candidates[0].evidence || "", /Failure: Command exited with code 1/);
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
