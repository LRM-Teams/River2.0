import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveAgentRoots, type PiAgentEnv } from "../paths/resolve-roots.ts";

export type SkillLifecycleKind = "draft" | "generated" | "enabled";

export type SkillLifecycleItem = {
	kind: SkillLifecycleKind;
	id: string;
	name: string;
	description: string;
	path: string;
	enabled: boolean;
	source?: string;
	enabledAt?: string;
};

export type SkillLifecycleList = {
	drafts: SkillLifecycleItem[];
	generated: SkillLifecycleItem[];
	enabled: SkillLifecycleItem[];
};

export type SkillEnableResult = {
	source: SkillLifecycleItem;
	enabled: SkillLifecycleItem;
	path: string;
	created: boolean;
};

export type SkillDisableResult = {
	id: string;
	path: string;
	removed: boolean;
};

type SkillFrontmatter = {
	name: string;
	description: string;
};

const ENABLED_MANIFEST = ".pi-skill-enabled.json";

export function listMemorySkills(env: PiAgentEnv = process.env): SkillLifecycleList {
	const roots = resolveAgentRoots(env);
	const skillsDir = roots.skillsDir;
	return {
		drafts: listSkillDir(roots.skillDraftsDir, "draft"),
		generated: listSkillDir(join(skillsDir, "generated"), "generated"),
		enabled: listSkillDir(join(skillsDir, "enabled"), "enabled"),
	};
}

export function enableMemorySkill(input: string, options: { force?: boolean; env?: PiAgentEnv } = {}): SkillEnableResult {
	const env = options.env ?? process.env;
	const roots = resolveAgentRoots(env);
	if (!roots.agentRoot) throw new Error("skill enable requires PI_AGENT_ROOT or Multica agent env");
	const source = resolveSourceSkill(input, env);
	const targetDir = join(roots.skillsDir, "enabled", source.name);
	const targetPath = join(targetDir, "SKILL.md");
	if (existsSync(targetPath) && !options.force) throw new Error(`enabled skill '${source.name}' already exists; pass force to replace it`);
	if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
	mkdirSync(targetDir, { recursive: true });
	copySkillDirectory(dirname(source.path), targetDir);
	const manifest = {
		name: source.name,
		description: source.description,
		source: `${source.kind}:${source.id}`,
		sourcePath: source.path,
		enabledAt: new Date().toISOString(),
	};
	writeFileSync(join(targetDir, ENABLED_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
	appendSkillAudit(roots.memoryDir, { action: "enable", ...manifest, targetPath });
	return {
		source,
		enabled: readSkillItem(targetPath, "enabled")!,
		path: targetPath,
		created: true,
	};
}

export function disableMemorySkill(idOrName: string, env: PiAgentEnv = process.env): SkillDisableResult {
	const roots = resolveAgentRoots(env);
	if (!roots.agentRoot) throw new Error("skill disable requires PI_AGENT_ROOT or Multica agent env");
	const enabled = listSkillDir(join(roots.skillsDir, "enabled"), "enabled");
	const item = enabled.find((candidate) => candidate.id === idOrName || candidate.name === idOrName);
	if (!item) throw new Error(`No enabled skill found for '${idOrName}'.`);
	const skillDir = dirname(item.path);
	rmSync(skillDir, { recursive: true, force: true });
	appendSkillAudit(roots.memoryDir, { action: "disable", name: item.name, id: item.id, targetPath: item.path });
	return { id: item.id, path: item.path, removed: true };
}

export function formatEnabledSkillsForPrompt(env: PiAgentEnv = process.env): string {
	const enabled = listMemorySkills(env).enabled;
	if (enabled.length === 0) return "";
	return [
		"<available_skills>",
		"The following current-agent skills were explicitly enabled by pi-memory. When a task matches, use the read tool to load the SKILL.md at the listed location before applying it.",
		...enabled.map((skill) => [
			"  <skill>",
			`    <name>${escapeXml(skill.name)}</name>`,
			`    <description>${escapeXml(skill.description)}</description>`,
			`    <location>${escapeXml(skill.path)}</location>`,
			"  </skill>",
		].join("\n")),
		"</available_skills>",
	].join("\n");
}

export function formatSkillList(list: SkillLifecycleList): string {
	const sections: string[] = [];
	for (const [label, items] of [["drafts", list.drafts], ["generated", list.generated], ["enabled", list.enabled]] as const) {
		sections.push(`${label}: ${items.length}`);
		for (const item of items) {
			sections.push(`- ${item.kind}:${item.id} (${item.name}) ${item.description} -> ${item.path}`);
		}
	}
	return sections.join("\n");
}

function resolveSourceSkill(input: string, env: PiAgentEnv): SkillLifecycleItem {
	const roots = resolveAgentRoots(env);
	const [rawKind, rawId] = input.includes(":") ? input.split(/:(.*)/s, 2) : ["", input];
	const kind = rawKind === "draft" || rawKind === "generated" || rawKind === "enabled" ? rawKind : undefined;
	if (rawKind && !kind) throw new Error(`Unknown skill source '${rawKind}'. Use draft:<id> or generated:<id>.`);
	const candidates = [
		...(kind === undefined || kind === "draft" ? listSkillDir(roots.skillDraftsDir, "draft") : []),
		...(kind === undefined || kind === "generated" ? listSkillDir(join(roots.skillsDir, "generated"), "generated") : []),
		...(kind === "enabled" ? listSkillDir(join(roots.skillsDir, "enabled"), "enabled") : []),
	];
	const id = rawId || rawKind;
	const item = candidates.find((candidate) => candidate.id === id || candidate.name === id);
	if (!item) throw new Error(`No skill found for '${input}'.`);
	if (item.kind === "enabled") throw new Error(`Skill '${item.name}' is already enabled.`);
	return item;
}

function listSkillDir(dir: string, kind: SkillLifecycleKind): SkillLifecycleItem[] {
	if (!existsSync(dir)) return [];
	const items: SkillLifecycleItem[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const skillPath = join(dir, entry.name, "SKILL.md");
		const item = readSkillItem(skillPath, kind, entry.name);
		if (item) items.push(item);
	}
	return items.sort((a, b) => a.id.localeCompare(b.id));
}

function readSkillItem(skillPath: string, kind: SkillLifecycleKind, id = basename(dirname(skillPath))): SkillLifecycleItem | null {
	if (!existsSync(skillPath)) return null;
	const content = readFileSync(skillPath, "utf-8");
	const frontmatter = parseSkillFrontmatter(content);
	if (!frontmatter) return null;
	const manifest = readManifest(dirname(skillPath));
	return {
		kind,
		id,
		name: frontmatter.name,
		description: frontmatter.description,
		path: skillPath,
		enabled: kind === "enabled",
		source: manifest?.source,
		enabledAt: manifest?.enabledAt,
	};
}

function copySkillDirectory(sourceDir: string, targetDir: string): void {
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		if (entry.isSymbolicLink() || entry.name === ENABLED_MANIFEST) continue;
		const sourcePath = join(sourceDir, entry.name);
		const targetPath = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			mkdirSync(targetPath, { recursive: true });
			copySkillDirectory(sourcePath, targetPath);
			continue;
		}
		if (!entry.isFile()) continue;
		mkdirSync(dirname(targetPath), { recursive: true });
		writeFileSync(targetPath, readFileSync(sourcePath));
	}
}

function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
	if (!content.startsWith("---\n")) return null;
	const end = content.indexOf("\n---", 4);
	if (end < 0) return null;
	const frontmatter = content.slice(4, end).split("\n");
	const result: Partial<SkillFrontmatter> = {};
	for (const line of frontmatter) {
		const index = line.indexOf(":");
		if (index < 0) continue;
		const key = line.slice(0, index).trim();
		const value = line.slice(index + 1).trim().replace(/^['\"]|['\"]$/g, "");
		if (key === "name") result.name = value;
		if (key === "description") result.description = value;
	}
	if (!result.name || !result.description) return null;
	return { name: result.name, description: result.description };
}

function readManifest(skillDir: string): { source?: string; enabledAt?: string } | null {
	const manifestPath = join(skillDir, ENABLED_MANIFEST);
	if (!existsSync(manifestPath)) return null;
	try {
		return JSON.parse(readFileSync(manifestPath, "utf-8")) as { source?: string; enabledAt?: string };
	} catch {
		return null;
	}
}

function appendSkillAudit(memoryDir: string, entry: Record<string, unknown>): void {
	const auditDir = join(memoryDir, "audit");
	mkdirSync(auditDir, { recursive: true });
	writeFileSync(join(auditDir, "skill-lifecycle.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, { encoding: "utf-8", flag: "a" });
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}
