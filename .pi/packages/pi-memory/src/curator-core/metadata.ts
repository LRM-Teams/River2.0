export type MemoryMetadata = Record<string, string>;

export type ParsedEntry = {
	metadata: MemoryMetadata;
	body: string;
	raw: string;
	hasMetadata: boolean;
};

const ORDERED_METADATA_KEYS = ["type", "provider", "status", "date", "reset", "month", "used", "limit", "ttlDays"];

export function parseMetadata(line: string): MemoryMetadata | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
	const inner = trimmed.slice(1, -1).trim();
	if (!inner) return {};
	const metadata: MemoryMetadata = {};
	for (const part of inner.split(/\s+/)) {
		const index = part.indexOf(":");
		if (index <= 0) continue;
		const key = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (key && value) metadata[key] = value;
	}
	return metadata;
}

export function serializeMetadata(metadata: MemoryMetadata): string {
	const keys = [
		...ORDERED_METADATA_KEYS.filter((key) => metadata[key] !== undefined),
		...Object.keys(metadata).filter((key) => !ORDERED_METADATA_KEYS.includes(key)).sort(),
	];
	return `[${keys.map((key) => `${key}:${metadata[key]}`).join(" ")}]`;
}

export function parseEntry(raw: string): ParsedEntry {
	const trimmed = raw.trim();
	const lines = trimmed.split("\n");
	const metadata = parseMetadata(lines[0]);
	if (metadata === undefined) return { metadata: {}, body: trimmed, raw: trimmed, hasMetadata: false };
	return { metadata, body: lines.slice(1).join("\n").trim(), raw: trimmed, hasMetadata: true };
}

export function renderEntry(entry: ParsedEntry): string {
	if (!entry.hasMetadata || Object.keys(entry.metadata).length === 0) return entry.body.trim();
	return `${serializeMetadata(entry.metadata)}\n${entry.body.trim()}`.trim();
}

export function todayUtc(now: Date): string {
	return now.toISOString().slice(0, 10);
}

export function currentMonth(now: Date): string {
	return now.toISOString().slice(0, 7);
}
