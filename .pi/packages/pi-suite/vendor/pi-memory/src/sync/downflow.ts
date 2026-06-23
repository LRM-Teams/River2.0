import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveAgentRoots, type PiAgentEnv } from "../paths/resolve-roots.ts";
import { detectSensitivity } from "./sensitivity.ts";
import type { Delivery } from "./schemas.ts";
import { validateSkillBundleFiles, writeSkillBundle } from "./skill-bundle.ts";

export type ReceiveDeliveryResult = {
	written: string[];
	accepted: boolean;
	reason?: string;
};

export function receiveDelivery(delivery: Delivery, env: PiAgentEnv = process.env): ReceiveDeliveryResult {
	const roots = resolveAgentRoots(env);
	if (!roots.inboxDir || !roots.sharedCacheDir || !roots.agentRoot) throw new Error("downflow receive requires PI_AGENT_ROOT or Multica agent env");
	if (detectSensitivity(JSON.stringify(delivery)) === "secret") return { written: [], accepted: false, reason: "secret-like delivery rejected" };
	const id = safeName(delivery.shared_unit_id || delivery.id);
	const written: string[] = [];
	if (delivery.unit_type === "memory") {
		const inboxPath = join(roots.inboxDir, "memory", `${id}.json`);
		const cachePath = join(roots.sharedCacheDir, "memory", `${id}.json`);
		writeJsonIfChanged(inboxPath, delivery);
		writeJsonIfChanged(cachePath, delivery);
		written.push(inboxPath, cachePath);
		return { written, accepted: true };
	}
	const inboxDir = join(roots.inboxDir, "skills", id);
	const generatedDir = join(roots.agentRoot, "skills", "generated", id);
	mkdirSync(inboxDir, { recursive: true });
	mkdirSync(generatedDir, { recursive: true });
	const skillContent = delivery.content.endsWith("\n") ? delivery.content : `${delivery.content}\n`;
	const files = validateSkillBundleFiles(delivery.files || []);
	written.push(...writeSkillBundle(inboxDir, skillContent, files));
	written.push(...writeSkillBundle(generatedDir, skillContent, files));
	writeJsonIfChanged(join(inboxDir, "delivery.json"), delivery);
	return { written, accepted: true };
}

function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "delivery";
}

function writeJsonIfChanged(filePath: string, value: unknown): void {
	writeTextIfChanged(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextIfChanged(filePath: string, value: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	if (existsSync(filePath)) {
		// Avoid rewriting cache files on duplicate pulls.
		return;
	}
	writeFileSync(filePath, value, "utf-8");
}
