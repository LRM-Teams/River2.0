import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

interface PackageEntryObject {
	source?: unknown;
}

interface SettingsFile {
	packages?: unknown;
}

interface RepairRequirement {
	source: string;
	description: string;
}

const REQUIRED_PACKAGES: RepairRequirement[] = [
	{ source: "npm:pi-mcp-adapter", description: "MCP tools" },
	{ source: "npm:pi-subagents", description: "subagent delegation" },
	{ source: "npm:pi-web-access", description: "web search/content tools" },
];

function readSettings(path: string): SettingsFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as SettingsFile) : undefined;
	} catch {
		return undefined;
	}
}

function packageSource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (!entry || typeof entry !== "object") return undefined;
	const source = (entry as PackageEntryObject).source;
	return typeof source === "string" ? source : undefined;
}

function packageSourcesFromSettings(settings: SettingsFile | undefined): string[] {
	if (!settings || !Array.isArray(settings.packages)) return [];
	return settings.packages.flatMap((entry) => {
		const source = packageSource(entry);
		return source ? [source] : [];
	});
}

function npmPackageName(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice("npm:".length);
	if (spec.startsWith("@")) {
		const slash = spec.indexOf("/");
		if (slash === -1) return undefined;
		const versionStart = spec.indexOf("@", slash + 1);
		return versionStart === -1 ? spec : spec.slice(0, versionStart);
	}
	const versionStart = spec.indexOf("@");
	return versionStart === -1 ? spec : spec.slice(0, versionStart);
}

function sourceIdentity(source: string): string {
	return npmPackageName(source) ?? source;
}

function isVersionPinnedNpmSource(source: string): boolean {
	if (!source.startsWith("npm:")) return false;
	const name = npmPackageName(source);
	return Boolean(name && source !== `npm:${name}`);
}

function requirementSatisfied(requirement: RepairRequirement, installedSources: string[]): boolean {
	if (isVersionPinnedNpmSource(requirement.source)) {
		return installedSources.includes(requirement.source);
	}
	const requiredIdentity = sourceIdentity(requirement.source);
	return installedSources.some((source) => sourceIdentity(source) === requiredIdentity);
}

function readInstalledPackageSources(ctx: ExtensionContext): string[] {
	const globalSettings = readSettings(join(getAgentDir(), "settings.json"));
	const projectSettings = readSettings(join(ctx.cwd, ".pi", "settings.json"));
	return [...packageSourcesFromSettings(globalSettings), ...packageSourcesFromSettings(projectSettings)];
}

function pendingRequirements(ctx: ExtensionContext): RepairRequirement[] {
	const installedSources = readInstalledPackageSources(ctx);
	return REQUIRED_PACKAGES.filter((requirement) => !requirementSatisfied(requirement, installedSources));
}

function formatRequirement(requirement: RepairRequirement): string {
	return `${requirement.source} (${requirement.description})`;
}

export default function piSuiteRepairExtension(pi: ExtensionAPI): void {
	let reminderShown = false;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || reminderShown) return;
		const pending = pendingRequirements(ctx);
		if (pending.length === 0) return;
		reminderShown = true;
		ctx.ui.notify(
			`pi-suite needs companion package repair: ${pending.map((item) => item.source).join(", ")}. Run /pi-suite-repair, then reload if prompted.`,
			"warning",
		);
	});

	pi.registerCommand("pi-suite-repair", {
		description: "Install missing required companion Pi packages, then reload resources.",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const pending = pendingRequirements(ctx);
			if (pending.length === 0) {
				ctx.ui.notify("pi-suite companion packages are already registered. No repair needed.", "info");
				return;
			}

			ctx.ui.notify(
				`Repairing missing pi-suite companion packages: ${pending.map((item) => item.source).join(", ")}`,
				"info",
			);

			const failures: string[] = [];
			for (const requirement of pending) {
				const result = await pi.exec("pi", ["install", requirement.source], { signal: ctx.signal, timeout: 120_000 });
				if (result.code !== 0) {
					const details = (result.stderr || result.stdout || "unknown error").trim();
					failures.push(`${formatRequirement(requirement)}: ${details}`);
				}
			}

			if (failures.length > 0) {
				ctx.ui.notify(`pi-suite repair failed: ${failures.join("; ")}`, "error");
				return;
			}

			ctx.ui.notify("pi-suite companion packages are installed. Reloading Pi resources...", "info");
			await ctx.reload();
		},
	});
}
