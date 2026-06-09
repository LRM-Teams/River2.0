export const ENTRY_DELIMITER = "\n§\n";
export const MEMORY_TARGETS = ["memory", "user", "state", "review"] as const;

export type MemoryTarget = (typeof MEMORY_TARGETS)[number];

export type CuratorState = {
	lastRunAt?: string;
	lastRunSummary?: string;
};

export interface MemoryStore {
	readEntries(target: MemoryTarget): Promise<string[]>;
	writeEntries(target: MemoryTarget, entries: string[]): Promise<void>;
	loadState(): Promise<CuratorState>;
	saveState(state: CuratorState): Promise<void>;
}

export function normalizeMemoryTarget(value: string | undefined, fallback: MemoryTarget = "memory"): MemoryTarget {
	const normalized = (value || fallback).trim().toLowerCase();
	return MEMORY_TARGETS.includes(normalized as MemoryTarget) ? (normalized as MemoryTarget) : fallback;
}
