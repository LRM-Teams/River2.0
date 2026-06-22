import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveMemoryRoot, type PiAgentEnv } from "./paths/resolve-roots.ts";

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

export type CuratorManagerServiceState = Omit<CuratorServiceState, "memoryDir"> & {
	registryPath: string;
};

export type CuratorManagerServiceResult = {
	ok: boolean;
	backend: CuratorServiceBackend;
	message: string;
	state: CuratorManagerServiceState;
};

export type CuratorServiceResult = {
	ok: boolean;
	backend: CuratorServiceBackend;
	message: string;
	state: CuratorServiceState;
};

const SERVICE_NAME = "jhp-pi-memory-curator";
const MANAGER_SERVICE_NAME = "jhp-pi-memory-curator-manager";
const DEFAULT_SCHEDULE = "03:00";
const DEFAULT_MANAGER_SCHEDULE = "0 */6 * * *";
const CRON_MARKER = "# jhp-pi-memory-curator";
const MANAGER_CRON_MARKER = "# jhp-pi-memory-curator-manager";

function resolveHome(): string {
	return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

export function resolveMemoryDir(env: PiAgentEnv = process.env): string {
	return resolveMemoryRoot(env);
}

function statePath(memoryDir: string): string {
	return join(memoryDir, ".curator-service.json");
}

function managerStatePath(registryPath: string): string {
	return join(dirname(registryPath), ".curator-manager-service.json");
}

function systemdUserDir(): string {
	return join(resolveHome(), ".config", "systemd", "user");
}

function servicePath(serviceName = SERVICE_NAME): string {
	return join(systemdUserDir(), `${serviceName}.service`);
}

function timerPath(serviceName = SERVICE_NAME): string {
	return join(systemdUserDir(), `${serviceName}.timer`);
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

function defaultManagerState(registryPath: string, cliPath: string): CuratorManagerServiceState {
	return {
		enabled: false,
		backend: "none",
		schedule: DEFAULT_MANAGER_SCHEDULE,
		serviceName: MANAGER_SERVICE_NAME,
		registryPath,
		cliPath,
	};
}

function readManagerState(registryPath: string, cliPath: string): CuratorManagerServiceState {
	const path = managerStatePath(registryPath);
	if (!existsSync(path)) return defaultManagerState(registryPath, cliPath);
	try {
		return { ...defaultManagerState(registryPath, cliPath), ...(JSON.parse(readFileSync(path, "utf-8")) as Partial<CuratorManagerServiceState>) };
	} catch {
		return defaultManagerState(registryPath, cliPath);
	}
}

function writeManagerState(state: CuratorManagerServiceState): void {
	mkdirSync(dirname(managerStatePath(state.registryPath)), { recursive: true });
	writeFileSync(managerStatePath(state.registryPath), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
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

function parseCronSchedule(schedule: string): string[] {
	const fields = schedule.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error(`Invalid cron schedule '${schedule}'. Expected five cron fields.`);
	return fields;
}

function systemdCalendar(schedule: string): string {
	const fields = schedule.trim().split(/\s+/);
	if (fields.length === 5) {
		const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
		if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") throw new Error(`Unsupported systemd schedule '${schedule}'. Use HH:MM or an every-N-hours cron like '0 */6 * * *'.`);
		if (!/^\d{1,2}$/.test(minute)) throw new Error(`Unsupported systemd schedule minute '${minute}'.`);
		const mm = minute.padStart(2, "0");
		if (/^\d{1,2}$/.test(hour)) return `*-*-* ${hour.padStart(2, "0")}:${mm}:00`;
		const step = /^\*\/(\d{1,2})$/.exec(hour)?.[1];
		if (step) return `*-*-* 00/${step}:${mm}:00`;
		if (hour === "*") return `*-*-* *:${mm}:00`;
		throw new Error(`Unsupported systemd schedule hour '${hour}'.`);
	}
	const { hour, minute } = parseSchedule(schedule);
	return `*-*-* ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:00`;
}

function writeSystemdUnits(options: { serviceName: string; description: string; execStart: string; schedule: string }): void {
	mkdirSync(systemdUserDir(), { recursive: true });
	writeFileSync(
		servicePath(options.serviceName),
		[
			"[Unit]",
			`Description=${options.description}`,
			"",
			"[Service]",
			"Type=oneshot",
			`ExecStart=${options.execStart}`,
			"",
		].join("\n"),
		"utf-8",
	);
	writeFileSync(
		timerPath(options.serviceName),
		[
			"[Unit]",
			`Description=Run ${options.description}`,
			"",
			"[Timer]",
			`OnCalendar=${systemdCalendar(options.schedule)}`,
			"Persistent=true",
			`Unit=${options.serviceName}.service`,
			"",
			"[Install]",
			"WantedBy=timers.target",
			"",
		].join("\n"),
		"utf-8",
	);
}

function enableSystemd(serviceName: string, description: string, execStart: string, schedule: string): void {
	writeSystemdUnits({ serviceName, description, execStart, schedule });
	execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
	execFileSync("systemctl", ["--user", "enable", "--now", `${serviceName}.timer`], { stdio: "ignore" });
}

function disableSystemd(serviceName = SERVICE_NAME): void {
	if (!hasCommand("systemctl")) return;
	spawnSync("systemctl", ["--user", "disable", "--now", `${serviceName}.timer`], { stdio: "ignore" });
	for (const path of [servicePath(serviceName), timerPath(serviceName)]) {
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

function removeCronLine(marker = CRON_MARKER): void {
	if (!hasCommand("crontab")) return;
	const existing = currentCrontab();
	const next = existing
		.split(/\r?\n/)
		.filter((line) => !line.includes(marker))
		.join("\n")
		.trim();
	installCrontab(next ? `${next}\n` : "");
}

function enableCron(command: string, schedule: string, marker = CRON_MARKER): void {
	if (!hasCommand("crontab")) throw new Error("Neither systemd user timers nor crontab are available.");
	const fields = schedule.includes(":") && schedule.trim().split(/\s+/).length === 1
		? (() => {
			const { hour, minute } = parseSchedule(schedule);
			return [minute, hour, "*", "*", "*"];
		})()
		: parseCronSchedule(schedule);
	removeCronLine(marker);
	const existing = currentCrontab().trim();
	const next = `${existing ? `${existing}\n` : ""}${fields.join(" ")} ${command} ${marker}\n`;
	installCrontab(next);
}

export function enableCuratorService(options: { memoryDir?: string; cliPath: string; schedule?: string }): CuratorServiceResult {
	const memoryDir = options.memoryDir || resolveMemoryDir();
	const schedule = options.schedule || DEFAULT_SCHEDULE;
	const baseState = { ...defaultState(memoryDir, options.cliPath), schedule };
	try {
		const command = `${shellQuote(process.execPath)} ${shellQuote(options.cliPath)} run-once --memory-dir ${shellQuote(memoryDir)} --reason cron`;
		if (canUseSystemdUser()) {
			const execStart = `${process.execPath} ${options.cliPath} run-once --memory-dir ${memoryDir} --reason systemd-timer`;
			enableSystemd(SERVICE_NAME, "JHP pi memory curator", execStart, schedule);
			const state: CuratorServiceState = { ...baseState, enabled: true, backend: "systemd-user", installedAt: new Date().toISOString() };
			writeState(state);
			return { ok: true, backend: "systemd-user", message: `Enabled systemd user timer for memory curation (${schedule}).`, state };
		}
		enableCron(command, schedule, CRON_MARKER);
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
	disableSystemd(SERVICE_NAME);
	try {
		removeCronLine(CRON_MARKER);
	} catch {
		// best effort cleanup
	}
	const state: CuratorServiceState = { ...previous, enabled: false, backend: "none", disabledAt: new Date().toISOString() };
	writeState(state);
	return { ok: true, backend: previous.backend, message: "Disabled memory curator service.", state };
}

export function enableCuratorManagerService(options: { registryPath: string; cliPath: string; schedule?: string }): CuratorManagerServiceResult {
	const schedule = options.schedule || DEFAULT_MANAGER_SCHEDULE;
	const baseState = { ...defaultManagerState(options.registryPath, options.cliPath), schedule };
	try {
		mkdirSync(dirname(options.registryPath), { recursive: true });
		const command = `${shellQuote(process.execPath)} ${shellQuote(options.cliPath)} manager-scan --registry ${shellQuote(options.registryPath)}`;
		if (canUseSystemdUser()) {
			const execStart = `${process.execPath} ${options.cliPath} manager-scan --registry ${options.registryPath}`;
			enableSystemd(MANAGER_SERVICE_NAME, "JHP pi memory curator manager", execStart, schedule);
			const state: CuratorManagerServiceState = { ...baseState, enabled: true, backend: "systemd-user", installedAt: new Date().toISOString() };
			writeManagerState(state);
			return { ok: true, backend: "systemd-user", message: `Enabled systemd user timer for local curator manager (${schedule}).`, state };
		}
		enableCron(command, schedule, MANAGER_CRON_MARKER);
		const state: CuratorManagerServiceState = { ...baseState, enabled: true, backend: "cron", installedAt: new Date().toISOString() };
		writeManagerState(state);
		return { ok: true, backend: "cron", message: `Enabled cron job for local curator manager (${schedule}).`, state };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const state: CuratorManagerServiceState = { ...baseState, enabled: false, backend: "none", lastError: message };
		writeManagerState(state);
		return { ok: false, backend: "none", message, state };
	}
}

export function disableCuratorManagerService(options: { registryPath: string; cliPath: string }): CuratorManagerServiceResult {
	const previous = readManagerState(options.registryPath, options.cliPath);
	disableSystemd(MANAGER_SERVICE_NAME);
	try {
		removeCronLine(MANAGER_CRON_MARKER);
	} catch {
		// best effort cleanup
	}
	const state: CuratorManagerServiceState = { ...previous, enabled: false, backend: "none", disabledAt: new Date().toISOString() };
	writeManagerState(state);
	return { ok: true, backend: previous.backend, message: "Disabled local curator manager service.", state };
}

export function getCuratorManagerServiceStatus(options: { registryPath: string; cliPath: string }): CuratorManagerServiceResult {
	const state = readManagerState(options.registryPath, options.cliPath);
	const parts = [
		`Local curator manager service: ${state.enabled ? "enabled" : "disabled"}`,
		`Backend: ${state.backend}`,
		`Schedule: ${state.schedule}`,
		`Registry: ${state.registryPath}`,
	];
	if (state.lastError) parts.push(`Last error: ${state.lastError}`);
	if (state.backend === "systemd-user" && hasCommand("systemctl")) {
		const active = spawnSync("systemctl", ["--user", "is-active", `${MANAGER_SERVICE_NAME}.timer`], { encoding: "utf-8" });
		parts.push(`systemd timer active: ${active.stdout.trim() || "unknown"}`);
	}
	return { ok: true, backend: state.backend, message: parts.join("\n"), state };
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
