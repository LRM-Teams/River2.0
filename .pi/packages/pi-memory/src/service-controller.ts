import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CuratorServiceBackend = "systemd-user" | "cron" | "none";

export type CuratorServiceState = {
	enabled: boolean;
	backend: CuratorServiceBackend;
	schedule: string;
	serviceName: string;
	memoryDir: string;
	cliPath: string;
	installedAt?: string;
	disabledAt?: string;
	lastError?: string;
};

export type CuratorServiceResult = {
	ok: boolean;
	backend: CuratorServiceBackend;
	message: string;
	state: CuratorServiceState;
};

const SERVICE_NAME = "jhp-pi-memory-curator";
const DEFAULT_SCHEDULE = "03:00";
const CRON_MARKER = "# jhp-pi-memory-curator";

function resolveHome(): string {
	return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

export function resolveMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PI_MEMORY_DIR) return env.PI_MEMORY_DIR;
	return join(resolveHome(), ".pi", "agent", "memory");
}

function statePath(memoryDir: string): string {
	return join(memoryDir, ".curator-service.json");
}

function systemdUserDir(): string {
	return join(resolveHome(), ".config", "systemd", "user");
}

function servicePath(): string {
	return join(systemdUserDir(), `${SERVICE_NAME}.service`);
}

function timerPath(): string {
	return join(systemdUserDir(), `${SERVICE_NAME}.timer`);
}

function defaultState(memoryDir: string, cliPath: string): CuratorServiceState {
	return {
		enabled: false,
		backend: "none",
		schedule: DEFAULT_SCHEDULE,
		serviceName: SERVICE_NAME,
		memoryDir,
		cliPath,
	};
}

function readState(memoryDir: string, cliPath: string): CuratorServiceState {
	const path = statePath(memoryDir);
	if (!existsSync(path)) return defaultState(memoryDir, cliPath);
	try {
		return { ...defaultState(memoryDir, cliPath), ...(JSON.parse(readFileSync(path, "utf-8")) as Partial<CuratorServiceState>) };
	} catch {
		return defaultState(memoryDir, cliPath);
	}
}

function writeState(state: CuratorServiceState): void {
	mkdirSync(dirname(statePath(state.memoryDir)), { recursive: true });
	writeFileSync(statePath(state.memoryDir), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function hasCommand(command: string): boolean {
	return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function canUseSystemdUser(): boolean {
	if (!hasCommand("systemctl")) return false;
	const result = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" });
	return result.status === 0;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseSchedule(schedule: string): { hour: string; minute: string } {
	const match = /^(\d{1,2}):(\d{2})$/.exec(schedule);
	if (!match) throw new Error(`Invalid schedule '${schedule}'. Expected HH:MM.`);
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error(`Invalid schedule '${schedule}'. Expected HH:MM.`);
	return { hour: String(hour), minute: String(minute) };
}

function systemdCalendar(schedule: string): string {
	const { hour, minute } = parseSchedule(schedule);
	return `*-*-* ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:00`;
}

function writeSystemdUnits(memoryDir: string, cliPath: string, schedule: string): void {
	mkdirSync(systemdUserDir(), { recursive: true });
	const execStart = `${process.execPath} ${cliPath} run-once --memory-dir ${memoryDir} --reason systemd-timer`;
	writeFileSync(
		servicePath(),
		[
			"[Unit]",
			"Description=JHP pi memory curator",
			"",
			"[Service]",
			"Type=oneshot",
			`ExecStart=${execStart}`,
			"",
		].join("\n"),
		"utf-8",
	);
	writeFileSync(
		timerPath(),
		[
			"[Unit]",
			"Description=Run JHP pi memory curator daily",
			"",
			"[Timer]",
			`OnCalendar=${systemdCalendar(schedule)}`,
			"Persistent=true",
			"Unit=jhp-pi-memory-curator.service",
			"",
			"[Install]",
			"WantedBy=timers.target",
			"",
		].join("\n"),
		"utf-8",
	);
}

function enableSystemd(memoryDir: string, cliPath: string, schedule: string): void {
	writeSystemdUnits(memoryDir, cliPath, schedule);
	execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
	execFileSync("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.timer`], { stdio: "ignore" });
}

function disableSystemd(): void {
	if (!hasCommand("systemctl")) return;
	spawnSync("systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.timer`], { stdio: "ignore" });
	for (const path of [servicePath(), timerPath()]) {
		try {
			if (existsSync(path)) unlinkSync(path);
		} catch {
			// best effort cleanup
		}
	}
	spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
}

function currentCrontab(): string {
	const result = spawnSync("crontab", ["-l"], { encoding: "utf-8" });
	if (result.status !== 0) return "";
	return result.stdout;
}

function installCrontab(content: string): void {
	const result = spawnSync("crontab", ["-"], { input: content, encoding: "utf-8" });
	if (result.status !== 0) throw new Error(result.stderr || "failed to install crontab");
}

function removeCronLine(): void {
	if (!hasCommand("crontab")) return;
	const existing = currentCrontab();
	const next = existing
		.split(/\r?\n/)
		.filter((line) => !line.includes(CRON_MARKER))
		.join("\n")
		.trim();
	installCrontab(next ? `${next}\n` : "");
}

function enableCron(memoryDir: string, cliPath: string, schedule: string): void {
	if (!hasCommand("crontab")) throw new Error("Neither systemd user timers nor crontab are available.");
	const { hour, minute } = parseSchedule(schedule);
	removeCronLine();
	const command = `${shellQuote(process.execPath)} ${shellQuote(cliPath)} run-once --memory-dir ${shellQuote(memoryDir)} --reason cron ${CRON_MARKER}`;
	const existing = currentCrontab().trim();
	const next = `${existing ? `${existing}\n` : ""}${minute} ${hour} * * * ${command}\n`;
	installCrontab(next);
}

export function enableCuratorService(options: { memoryDir?: string; cliPath: string; schedule?: string }): CuratorServiceResult {
	const memoryDir = options.memoryDir || resolveMemoryDir();
	const schedule = options.schedule || DEFAULT_SCHEDULE;
	const baseState = { ...defaultState(memoryDir, options.cliPath), schedule };
	try {
		if (canUseSystemdUser()) {
			enableSystemd(memoryDir, options.cliPath, schedule);
			const state: CuratorServiceState = { ...baseState, enabled: true, backend: "systemd-user", installedAt: new Date().toISOString() };
			writeState(state);
			return { ok: true, backend: "systemd-user", message: "Enabled systemd user timer for daily 03:00 memory curation.", state };
		}
		enableCron(memoryDir, options.cliPath, schedule);
		const state: CuratorServiceState = { ...baseState, enabled: true, backend: "cron", installedAt: new Date().toISOString() };
		writeState(state);
		return { ok: true, backend: "cron", message: "Enabled cron job for daily memory curation.", state };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const state: CuratorServiceState = { ...baseState, enabled: false, backend: "none", lastError: message };
		writeState(state);
		return { ok: false, backend: "none", message, state };
	}
}

export function disableCuratorService(options: { memoryDir?: string; cliPath: string }): CuratorServiceResult {
	const memoryDir = options.memoryDir || resolveMemoryDir();
	const previous = readState(memoryDir, options.cliPath);
	disableSystemd();
	try {
		removeCronLine();
	} catch {
		// best effort cleanup
	}
	const state: CuratorServiceState = { ...previous, enabled: false, backend: "none", disabledAt: new Date().toISOString() };
	writeState(state);
	return { ok: true, backend: previous.backend, message: "Disabled memory curator service.", state };
}

export function getCuratorServiceStatus(options: { memoryDir?: string; cliPath: string }): CuratorServiceResult {
	const memoryDir = options.memoryDir || resolveMemoryDir();
	const state = readState(memoryDir, options.cliPath);
	const parts = [
		`Memory curator service: ${state.enabled ? "enabled" : "disabled"}`,
		`Backend: ${state.backend}`,
		`Schedule: ${state.schedule}`,
		`Memory dir: ${state.memoryDir}`,
	];
	if (state.lastError) parts.push(`Last error: ${state.lastError}`);
	if (state.backend === "systemd-user" && hasCommand("systemctl")) {
		const active = spawnSync("systemctl", ["--user", "is-active", `${SERVICE_NAME}.timer`], { encoding: "utf-8" });
		parts.push(`systemd timer active: ${active.stdout.trim() || "unknown"}`);
	}
	return { ok: true, backend: state.backend, message: parts.join("\n"), state };
}
