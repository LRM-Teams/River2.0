import * as fs from "node:fs";
import * as path from "node:path";

export function pathExists(filePath: string): boolean {
	try {
		fs.accessSync(filePath);
		return true;
	} catch {
		return false;
	}
}

export function emptyDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
}

export function copyDirContents(source: string, destination: string, options: { exclude?: (relativePath: string, isDirectory: boolean) => boolean } = {}): void {
	fs.mkdirSync(destination, { recursive: true });
	if (!pathExists(source)) return;
	const entries = fs.readdirSync(source, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = path.join(source, entry.name);
		const destinationPath = path.join(destination, entry.name);
		const relativePath = entry.name;
		if (options.exclude?.(relativePath, entry.isDirectory())) continue;
		copyPath(sourcePath, destinationPath, options, relativePath);
	}
}

function copyPath(source: string, destination: string, options: { exclude?: (relativePath: string, isDirectory: boolean) => boolean }, relativePath: string): void {
	const stat = fs.lstatSync(source);
	if (options.exclude?.(relativePath, stat.isDirectory())) return;
	if (stat.isDirectory()) {
		fs.mkdirSync(destination, { recursive: true });
		for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
			copyPath(path.join(source, entry.name), path.join(destination, entry.name), options, path.join(relativePath, entry.name));
		}
		return;
	}
	if (stat.isSymbolicLink()) {
		try {
			fs.symlinkSync(fs.readlinkSync(source), destination);
		} catch {
			// If symlink recreation fails (for example on Windows), copy target contents instead.
			fs.copyFileSync(fs.realpathSync(source), destination);
		}
		return;
	}
	if (stat.isFile()) {
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(source, destination);
	}
}

export function replaceDirFrom(source: string, destination: string): void {
	emptyDir(destination);
	copyDirContents(source, destination);
}

export function countFiles(dir: string): number {
	if (!pathExists(dir)) return 0;
	let count = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) count += countFiles(entryPath);
		else if (entry.isFile() || entry.isSymbolicLink()) count += 1;
	}
	return count;
}
