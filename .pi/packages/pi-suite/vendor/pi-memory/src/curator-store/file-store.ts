import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENTRY_DELIMITER, type CuratorState, type MemoryStore, type MemoryTarget } from "./types.ts";

export const DEFAULT_MEMORY_DIR = join(process.env.HOME || process.cwd(), ".pi", "agent", "memory");

export class FileMemoryStore implements MemoryStore {
	readonly memoryDir: string;

	constructor(memoryDir = DEFAULT_MEMORY_DIR) {
		this.memoryDir = memoryDir;
	}

	async readEntries(target: MemoryTarget): Promise<string[]> {
		const path = this.pathForTarget(target);
		if (!existsSync(path)) return [];
		const raw = readFileSync(path, "utf-8").trim();
		if (!raw) return [];
		return raw.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
	}

	async writeEntries(target: MemoryTarget, entries: string[]): Promise<void> {
		this.atomicWrite(this.pathForTarget(target), entries.map((entry) => entry.trim()).filter(Boolean).join(ENTRY_DELIMITER));
	}

	async loadState(): Promise<CuratorState> {
		const path = join(this.memoryDir, ".curator-state.json");
		if (!existsSync(path)) return {};
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as CuratorState;
		} catch {
			return {};
		}
	}

	async saveState(state: CuratorState): Promise<void> {
		this.atomicWrite(join(this.memoryDir, ".curator-state.json"), `${JSON.stringify(state, null, 2)}\n`);
	}

	pathForTarget(target: MemoryTarget): string {
		const name = target === "memory" ? "MEMORY" : target === "user" ? "USER" : target === "state" ? "STATE" : "REVIEW";
		return join(this.memoryDir, `${name}.md`);
	}

	private atomicWrite(path: string, content: string): void {
		mkdirSync(dirname(path), { recursive: true });
		const tmpPath = join(dirname(path), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		writeFileSync(tmpPath, content, "utf-8");
		renameSync(tmpPath, path);
	}
}
