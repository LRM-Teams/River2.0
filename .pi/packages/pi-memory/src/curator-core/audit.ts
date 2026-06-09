import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryPatch } from "./patch.ts";
import type { MemoryTarget } from "../curator-store/types.ts";

export interface AuditLog {
	write(entry: AuditEntry): Promise<void>;
}

export type AuditEntry = {
	runId: string;
	target: MemoryTarget;
	operation: MemoryPatch["operation"];
	old?: string;
	new?: string;
	reason: string;
	reviewedAt: string;
	actor: "pi-memory-curator";
};

export class JsonlAuditLog implements AuditLog {
	readonly path: string;

	constructor(memoryDir: string, auditPath?: string) {
		this.path = auditPath || join(memoryDir, "audit", "curator.jsonl");
	}

	async write(entry: AuditEntry): Promise<void> {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", flag: "a" });
	}
}

export function auditEntryFromPatch(runId: string, patch: MemoryPatch, reviewedAt: string): AuditEntry {
	return {
		runId,
		target: patch.target,
		operation: patch.operation,
		old: patch.oldText,
		new: patch.newText,
		reason: patch.reason,
		reviewedAt,
		actor: "pi-memory-curator",
	};
}
