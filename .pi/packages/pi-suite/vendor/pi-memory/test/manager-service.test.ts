import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getCuratorManagerServiceStatus } from "../src/index.ts";

test("manager service status defaults to six-hour dirty-root scan schedule", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-memory-manager-service-"));
	const registryPath = join(root, "multica_workspaces", ".pi-curator", "registry.json");
	const result = getCuratorManagerServiceStatus({ registryPath, cliPath: "/tmp/jhp-pi-memory-curator" });
	assert.equal(result.ok, true);
	assert.equal(result.state.enabled, false);
	assert.equal(result.state.schedule, "0 */6 * * *");
	assert.equal(result.state.registryPath, registryPath);
	assert.match(result.message, /Local curator manager service: disabled/);
});
