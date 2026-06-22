import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LspmuxState {
	available: boolean;
	running: boolean;
	command?: string;
}

function commandExists(command: string): boolean {
	const pathValue = process.env.PATH ?? "";
	for (const entry of pathValue.split(path.delimiter)) {
		if (!entry) continue;
		const full = path.join(entry, command);
		try {
			fs.accessSync(full, fs.constants.X_OK);
			return true;
		} catch {}
	}
	return false;
}

export async function detectLspmux(): Promise<LspmuxState> {
	const available = commandExists("lspmux");
	if (!available) return { available: false, running: false };
	const socket = path.join(os.tmpdir(), `lspmux-${process.getuid?.() ?? "user"}.sock`);
	return { available: true, running: fs.existsSync(socket), command: "lspmux" };
}

export function isLspmuxSupported(_command: string): boolean {
	return process.env.PI_LSPMUX === "1";
}

export async function getLspmuxCommand(
	command: string,
	args: string[],
): Promise<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> {
	if (!isLspmuxSupported(command)) return { command, args };
	const state = await detectLspmux();
	if (!state.available) return { command, args };
	return { command: state.command ?? "lspmux", args: [command, ...args] };
}
