import { MEMORY_TARGETS, type MemoryTarget } from "../curator-store/types.ts";

export const MEMORY_PATCH_OPERATIONS = ["replace", "append_review", "dedupe"] as const;

export type MemoryPatchOperation = (typeof MEMORY_PATCH_OPERATIONS)[number];

export interface MemoryPatch {
	target: MemoryTarget;
	operation: MemoryPatchOperation;
	oldText?: string;
	newText?: string;
	reason: string;
	confidence: "high" | "medium" | "low";
}

export function validateMemoryPatch(patch: MemoryPatch): string[] {
	const errors: string[] = [];
	if (!MEMORY_TARGETS.includes(patch.target)) errors.push(`invalid target '${patch.target}'`);
	if (!MEMORY_PATCH_OPERATIONS.includes(patch.operation)) errors.push(`invalid operation '${patch.operation}'`);
	if (!patch.reason.trim()) errors.push("reason is required");
	if (patch.operation === "replace" && (!patch.oldText?.trim() || !patch.newText?.trim())) errors.push("replace requires oldText and newText");
	if (patch.operation === "append_review" && !patch.newText?.trim()) errors.push("append_review requires newText");
	return errors;
}
