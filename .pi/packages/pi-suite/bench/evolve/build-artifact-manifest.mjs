#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_HASH_BYTES = 64 * 1024 * 1024;
const root = path.resolve(process.argv[2] || ".");
const output = path.resolve(process.argv[3] || "artifact-manifest.json");
const skippedDirectories = new Set([".git", ".pi", ".agents", "node_modules", "session", "sessions", ".cache"]);
const files = [];
const stack = [root];

while (stack.length > 0) {
	const directory = stack.pop();
	if (!directory) break;
	let entries = [];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		continue;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const absolutePath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!skippedDirectories.has(entry.name)) stack.push(absolutePath);
			continue;
		}
		if (!entry.isFile()) continue;
		try {
			const size = statSync(absolutePath).size;
			files.push({
				path: path.relative(root, absolutePath).replaceAll(path.sep, "/"),
				size,
				sha256:
					size <= MAX_HASH_BYTES ? createHash("sha256").update(readFileSync(absolutePath)).digest("hex") : null,
			});
		} catch {
			continue;
		}
	}
}

files.sort((left, right) => left.path.localeCompare(right.path));
writeFileSync(output, `${JSON.stringify({ root, files }, null, 2)}\n`);
