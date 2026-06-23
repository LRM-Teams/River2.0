import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type SkillBundleFile = {
	path: string;
	content: string;
};

export type SkillBundle = {
	name: string;
	description: string;
	content: string;
	source_path: string;
	provider: "pi";
	content_hash: string;
	files: SkillBundleFile[];
};

const MAX_SKILL_FILE_SIZE = 1 << 20;
const MAX_SKILL_BUNDLE_SIZE = 8 << 20;
const MAX_SKILL_FILE_COUNT = 128;

export function loadSkillBundle(skillDir: string): SkillBundle {
	const resolvedDir = resolve(skillDir);
	const skillPath = join(resolvedDir, "SKILL.md");
	if (!existsSync(skillPath)) throw new Error(`skill bundle requires SKILL.md: ${skillPath}`);
	const content = readBoundedFile(skillPath);
	const frontmatter = parseSkillFrontmatter(content);
	if (!frontmatter.name) throw new Error(`skill SKILL.md must include frontmatter name: ${skillPath}`);
	const files = collectSkillSupportingFiles(resolvedDir);
	return {
		name: frontmatter.name,
		description: frontmatter.description || "",
		content,
		source_path: resolvedDir,
		provider: "pi",
		content_hash: hashSkillBundle(content, files),
		files,
	};
}

export function writeSkillBundle(skillDir: string, content: string, files: SkillBundleFile[] = []): string[] {
	const resolvedDir = resolve(skillDir);
	const written: string[] = [];
	const mainPath = join(resolvedDir, "SKILL.md");
	writeTextIfChanged(mainPath, content.endsWith("\n") ? content : `${content}\n`);
	written.push(mainPath);
	for (const file of validateSkillBundleFiles(files)) {
		const target = join(resolvedDir, file.path);
		writeTextIfChanged(target, file.content);
		written.push(target);
	}
	return written;
}

export function validateSkillBundleFiles(files: SkillBundleFile[] = []): SkillBundleFile[] {
	const valid: SkillBundleFile[] = [];
	for (const file of files) {
		const clean = normalizeSkillFilePath(file.path);
		if (!clean) continue;
		valid.push({ path: clean, content: String(file.content ?? "") });
	}
	return valid.sort((a, b) => a.path.localeCompare(b.path));
}

export function hashSkillBundle(content: string, files: SkillBundleFile[]): string {
	const h = createHash("sha256");
	h.update(content);
	for (const file of validateSkillBundleFiles(files)) {
		h.update(`\0${file.path}\0${file.content}`);
	}
	return `sha256:${h.digest("hex")}`;
}

function collectSkillSupportingFiles(skillDir: string): SkillBundleFile[] {
	const files: SkillBundleFile[] = [];
	let totalSize = 0;
	function walk(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			if (isIgnoredSkillEntry(entry.name)) continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			const rel = normalizeSkillFilePath(relative(skillDir, fullPath));
			if (!rel) continue;
			const info = statSync(fullPath);
			if (info.size > MAX_SKILL_FILE_SIZE) continue;
			if (files.length >= MAX_SKILL_FILE_COUNT) throw new Error(`local skill exceeds ${MAX_SKILL_FILE_COUNT} files`);
			totalSize += info.size;
			if (totalSize > MAX_SKILL_BUNDLE_SIZE) throw new Error(`local skill exceeds ${MAX_SKILL_BUNDLE_SIZE} bytes in total`);
			files.push({ path: rel, content: readFileSync(fullPath, "utf-8") });
		}
	}
	walk(skillDir);
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

function readBoundedFile(filePath: string): string {
	const info = statSync(filePath);
	if (info.size > MAX_SKILL_FILE_SIZE) throw new Error(`SKILL.md exceeds ${MAX_SKILL_FILE_SIZE} bytes`);
	return readFileSync(filePath, "utf-8");
}

function normalizeSkillFilePath(path: string): string | null {
	const normalized = path.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
	if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return null;
	if (normalized.startsWith("/") || normalized.startsWith("~")) return null;
	if (normalized.toLowerCase() === "skill.md") return null;
	return normalized;
}

function isIgnoredSkillEntry(name: string): boolean {
	if (!name || name.startsWith(".")) return true;
	switch (name.toLowerCase()) {
		case "skill.md":
		case "license":
		case "license.md":
		case "license.txt":
			return true;
		default:
			return false;
	}
}

function parseSkillFrontmatter(content: string): { name: string; description: string } {
	if (!content.startsWith("---\n")) return { name: "", description: "" };
	const end = content.indexOf("\n---", 4);
	if (end < 0) return { name: "", description: "" };
	const result: { name: string; description: string } = { name: "", description: "" };
	for (const line of content.slice(4, end).split("\n")) {
		const index = line.indexOf(":");
		if (index < 0) continue;
		const key = line.slice(0, index).trim();
		const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
		if (key === "name") result.name = value;
		if (key === "description") result.description = value;
	}
	return result;
}

function writeTextIfChanged(filePath: string, value: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	if (existsSync(filePath)) return;
	writeFileSync(filePath, value, "utf-8");
}
