import assert from "node:assert/strict";
import { test } from "node:test";
import { countPendingReviewItems, formatPendingReviewList, listPendingReviewItems } from "../src/index.ts";

const reviewText = [
	`[type:review status:proposed id:mem_123 kind:memory_promotion confidence:high promotes_to:user]
Proposal: Promote reviewed candidate to user.
Memory: [type:preference]
Use LSP rename for cross-file refactors.`,
	`[type:review status:proposed id:skill_123 kind:skill_promotion confidence:high promotes_to:/tmp/skills/demo/SKILL.md]
Title: Demo Skill
Description: Use when repeated evidence appears.`,
	`[type:review status:approved id:mem_done kind:memory_promotion]
Already done.`,
	`not valid metadata but should not throw`,
].join("\n§\n");

test("counts pending memory and skill proposals", () => {
	assert.deepEqual(countPendingReviewItems(reviewText), { memory: 1, skill: 1, incoming: 0, total: 2 });
});

test("lists pending proposals with filters", () => {
	const memory = listPendingReviewItems(reviewText, { type: "memory" });
	assert.equal(memory.length, 1);
	assert.equal(memory[0].id, "mem_123");
	const skill = listPendingReviewItems(reviewText, { type: "skill" });
	assert.equal(skill.length, 1);
	assert.equal(skill[0].id, "skill_123");
});

test("formats pending review list", () => {
	const text = formatPendingReviewList(listPendingReviewItems(reviewText), countPendingReviewItems(reviewText));
	assert.match(text, /1 memory \/ 1 skill/);
	assert.match(text, /mem_123/);
	assert.match(text, /skill_123/);
});
