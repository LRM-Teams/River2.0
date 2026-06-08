import assert from "node:assert/strict";
import { test } from "node:test";
import { createLifecyclePatches } from "../src/index.ts";

const now = new Date("2026-06-08T03:00:00.000Z");

test("marks past planned event as past", () => {
	const patches = createLifecyclePatches("state", ["[type:event status:planned date:2026-06-06]\nUser plans to watch NBA."], now);
	assert.equal(patches.length, 1);
	assert.equal(patches[0].operation, "replace");
	assert.equal(patches[0].newText, "[type:event status:past date:2026-06-06]\nUser had planned to watch NBA. Completion status unknown.");
});

test("marks same-day event as today", () => {
	const patches = createLifecyclePatches("state", ["[type:event status:planned date:2026-06-08]\nUser plans to watch NBA."], now);
	assert.equal(patches[0].newText, "[type:event status:today date:2026-06-08]\nUser plans to watch NBA.");
});

test("keeps future event planned", () => {
	const patches = createLifecyclePatches("state", ["[type:event status:planned date:2026-06-09]\nUser plans to watch NBA."], now);
	assert.deepEqual(patches, []);
});

test("leaves plain date-like text untouched", () => {
	const patches = createLifecyclePatches("state", ["User plans to watch NBA on 2026-06-06."], now);
	assert.deepEqual(patches, []);
});

test("resets quota when reset date has passed", () => {
	const patches = createLifecyclePatches("state", ["[type:quota provider:exa status:exhausted month:2026-06 used:1000 limit:1000 reset:2026-06-08]\nExa search quota is exhausted."], now);
	assert.equal(patches[0].newText, "[type:quota provider:exa status:active reset:2026-06-08 month:2026-06 used:0 limit:1000]\nexa search quota is active for 2026-06.");
});
