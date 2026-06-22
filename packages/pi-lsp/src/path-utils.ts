import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NARROW_NO_BREAK_SPACE = "\u202F";

export function resolveToCwd(filePath: string, cwd: string): string {
	let normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	normalized = normalized.replace(/\u00a0|\u202f/g, " ");
	if (normalized === "~" || normalized.startsWith("~/")) {
		const home = process.env.HOME ?? process.cwd();
		normalized = path.join(home, normalized.slice(2));
	}
	return path.resolve(cwd, normalized);
}

export function formatPathRelativeToCwd(filePath: string, cwd: string): string {
	const relative = path.relative(cwd, filePath);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

export function fileToUri(filePath: string): string {
	return pathToFileURL(filePath).href;
}

export function uriToFile(uri: string): string {
	return fileURLToPath(uri);
}

export function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}
