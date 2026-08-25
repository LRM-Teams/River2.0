/**
 * bench-control: deadline and search-budget discipline for unattended eval runs.
 *
 * The runner provides PI_BENCH_DEADLINE_EPOCH (Unix seconds). This extension
 * steers the agent into artifact finalization before the outer hard timeout and
 * enforces explicit search limits found in the task prompt.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SEARCH_TOOL_NAMES = new Set(["web_search", "websearch", "search", "search_query", "internet_search"]);
const DEFAULT_FINALIZE_SECONDS = 90;
const CHECKPOINT_FRACTIONS = [0.25, 0.5, 0.75] as const;
const MINIMUM_PI_VERSION = "0.84.3";
const REQUIRED_BENCH_TOOLS = ["update_plan", "gemini_vision", "image_contact_sheet", "video_frames", "image_crop", "media_probe"];
const FINALIZATION_BASH_PATTERN =
	/(?:\b(?:apt(?:-get)?|dnf|yum|pacman|brew|conda|mamba|pipx?)\s+install\b|\bnpm\s+(?:i|install|ci)\b|\b(?:pnpm|yarn|bun)\s+(?:add|install)\b|\bgit\s+clone\b|\b(?:curl|wget)\b)/i;

interface RuntimeManifest {
	type: "runtime-manifest";
	piVersion: string;
	minimumPiVersion: string;
	piVersionSupported: boolean;
	suiteVersion: string;
	activeTools: string[];
	missingExpectedTools: string[];
	benchChild: boolean;
	deadlineEpoch?: number;
	finalizeSeconds?: number;
	warnings: string[];
}

export function parseSearchLimit(prompt: string): number | undefined {
	const patterns = [
		/(?:total\s+number\s+of\s+)?(?:search(?:es)?|search(?:\s+engine)?\s+quer(?:y|ies))[\s\S]{0,80}?(?:must\s+not\s+exceed|no\s+more\s+than|not\s+exceed|maximum(?:\s+of)?|at\s+most|less\s+than\s+or\s+equal\s+to)\s*(\d+)/i,
		/(?:搜索|检索)[\s\S]{0,40}?(?:不得超过|不能超过|不超过|至多|最多)\s*(\d+)/,
	];
	for (const pattern of patterns) {
		const match = prompt.match(pattern);
		if (!match) continue;
		const limit = Number(match[1]);
		if (Number.isInteger(limit) && limit > 0) return limit;
	}
	return undefined;
}

export function countSearchQueries(input: Record<string, unknown>): number {
	const queries = input.queries ?? input.search_queries;
	if (Array.isArray(queries)) {
		return queries.filter((query) => {
			if (typeof query === "string") return query.trim().length > 0;
			if (!query || typeof query !== "object") return false;
			const candidate = query as Record<string, unknown>;
			const value = candidate.q ?? candidate.query;
			return typeof value === "string" && value.trim().length > 0;
		}).length;
	}
	const query = input.query ?? input.q;
	return typeof query === "string" && query.trim().length > 0 ? 1 : 0;
}

export function isSupportedPiVersion(version: string): boolean {
	const parse = (value: string): [number, number, number] | undefined => {
		const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
		if (!match) return undefined;
		return [Number(match[1]), Number(match[2]), Number(match[3])];
	};
	const actual = parse(version);
	const minimum = parse(MINIMUM_PI_VERSION);
	if (!actual || !minimum) return false;
	for (let index = 0; index < actual.length; index += 1) {
		if (actual[index] > minimum[index]) return true;
		if (actual[index] < minimum[index]) return false;
	}
	return true;
}

export function finalizationBlockReason(toolName: string, input: Record<string, unknown>): string | undefined {
	if (SEARCH_TOOL_NAMES.has(toolName)) return "new searches are blocked";
	if (toolName === "gemini_vision") return "new remote vision calls are blocked";
	if (toolName !== "bash") return undefined;
	const command = String(input.command ?? "");
	if (FINALIZATION_BASH_PATTERN.test(command)) return "installations, clones, and new downloads are blocked";
	return undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requestedArtifactPaths(prompt: string): string[] {
	const matches = prompt.match(/\/tmp_workspace\/[A-Za-z0-9_./-]+/g) ?? [];
	return [...new Set(matches.filter((candidate) => /\.[A-Za-z0-9]{1,8}$/.test(candidate)))].slice(0, 8);
}

function readSuiteVersion(): string {
	try {
		const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version?: unknown;
		};
		return typeof packageJson.version === "string" ? packageJson.version : "unknown";
	} catch {
		return "unknown";
	}
}

async function detectPiVersion(pi: ExtensionAPI): Promise<string> {
	if (process.env.PI_RUNTIME_VERSION) return process.env.PI_RUNTIME_VERSION;
	try {
		const result = await pi.exec("pi", ["--version"], { timeout: 5_000 });
		const match = result.stdout.trim().match(/\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?/);
		return match?.[0] ?? "unknown";
	} catch {
		return "unknown";
	}
}

function artifactIsUsable(candidate: string, cwd: string): boolean {
	const absolutePath = path.isAbsolute(candidate) ? candidate : path.join(cwd, candidate);
	try {
		return existsSync(absolutePath) && statSync(absolutePath).isFile() && statSync(absolutePath).size > 0;
	} catch {
		return false;
	}
}

export default function benchControlExtension(pi: ExtensionAPI): void {
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let checkpointTimers: Array<ReturnType<typeof setTimeout>> = [];
	let hardSearchLimit: number | undefined;
	let searchCount = 0;
	let finalizing = false;
	let artifactPaths: string[] = [];
	let sessionCwd = process.cwd();
	let incompatiblePiVersion = false;

	const clearTimers = (): void => {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		deadlineTimer = undefined;
		for (const timer of checkpointTimers) clearTimeout(timer);
		checkpointTimers = [];
	};

	pi.on("session_start", async (_event, ctx) => {
		clearTimers();
		hardSearchLimit = undefined;
		searchCount = 0;
		finalizing = false;
		artifactPaths = [];
		sessionCwd = ctx.cwd;
		const piVersion = await detectPiVersion(pi);
		incompatiblePiVersion = piVersion !== "unknown" && !isSupportedPiVersion(piVersion);

		const deadlineEpoch = Number(process.env.PI_BENCH_DEADLINE_EPOCH);
		const finalizeSeconds = parsePositiveInteger(
			process.env.PI_BENCH_FINALIZE_SECONDS,
			DEFAULT_FINALIZE_SECONDS,
		);
		const activeTools = [...pi.getActiveTools()].sort();
		const missingExpectedTools = REQUIRED_BENCH_TOOLS.filter((tool) => !activeTools.includes(tool));
		const warnings: string[] = [];
		if (incompatiblePiVersion) warnings.push(`Pi ${piVersion} is older than required ${MINIMUM_PI_VERSION}`);
		if (piVersion === "unknown") warnings.push("Pi runtime version could not be detected");
		if (process.env.PI_BENCH_CHILD === "1" && (!Number.isFinite(deadlineEpoch) || deadlineEpoch <= 0)) {
			warnings.push("PI_BENCH_DEADLINE_EPOCH is missing or invalid");
		}
		if (missingExpectedTools.length > 0) warnings.push(`expected tools are inactive: ${missingExpectedTools.join(", ")}`);
		const manifest: RuntimeManifest = {
			type: "runtime-manifest",
			piVersion,
			minimumPiVersion: MINIMUM_PI_VERSION,
			piVersionSupported: piVersion !== "unknown" && !incompatiblePiVersion,
			suiteVersion: readSuiteVersion(),
			activeTools,
			missingExpectedTools,
			benchChild: process.env.PI_BENCH_CHILD === "1",
			...(Number.isFinite(deadlineEpoch) && deadlineEpoch > 0 ? { deadlineEpoch, finalizeSeconds } : {}),
			warnings,
		};
		pi.appendEntry("pi-suite-runtime-manifest", manifest);
		pi.appendEntry("pi-suite-extension-health", { extension: "bench-control", status: "active" });
		if (warnings.length > 0 && ctx.hasUI) ctx.ui.notify(`pi-suite runtime warning: ${warnings.join("; ")}`, "warning");

		if (!Number.isFinite(deadlineEpoch) || deadlineEpoch <= 0) return;
		const now = Date.now();
		const finalizeAt = deadlineEpoch * 1000 - finalizeSeconds * 1000;
		const workingWindowMs = Math.max(0, finalizeAt - now);
		for (const fraction of CHECKPOINT_FRACTIONS) {
			checkpointTimers.push(setTimeout(() => {
				const missing = artifactPaths.filter((candidate) => !artifactIsUsable(candidate, sessionCwd));
				pi.appendEntry("bench-control", {
					type: "artifact-checkpoint",
					fraction,
					requested: artifactPaths,
					missing,
				});
				if (missing.length === 0) return;
				void pi.sendMessage(
					{
						customType: "bench-control",
						content: `Benchmark budget checkpoint ${Math.round(fraction * 100)}%: these requested artifacts are still missing or empty: ${missing.join(", ")}. Create a minimally valid draft now, then improve it incrementally.`,
						display: true,
						details: { fraction, missing },
					},
					{ deliverAs: "steer", triggerTurn: true },
				).catch(() => {});
			}, Math.max(0, Math.floor(workingWindowMs * fraction))));
		}
		const delayMs = Math.max(0, deadlineEpoch * 1000 - Date.now() - finalizeSeconds * 1000);
		deadlineTimer = setTimeout(() => {
			finalizing = true;
			void pi.sendMessage(
				{
					customType: "bench-control",
					content:
						"The benchmark deadline is approaching. Stop exploration now. Write the best supportable answer to every requested output file, even if partial, then only verify that each artifact exists and is readable. Do not start new searches, model calls, broad scans, or installations.",
					display: true,
					details: { deadlineEpoch, finalizeSeconds },
				},
				{ deliverAs: "steer", triggerTurn: true },
			).catch(() => {});
		}, delayMs);
	});

	pi.on("session_shutdown", () => {
		clearTimers();
	});

	pi.on("before_agent_start", (event) => {
		if (incompatiblePiVersion && process.env.PI_BENCH_CHILD === "1") {
			throw new Error(`pi-suite requires Pi ${MINIMUM_PI_VERSION} or newer`);
		}
		if (finalizing) return undefined;
		const promptSearchLimit = parseSearchLimit(event.prompt);
		if (promptSearchLimit !== undefined) {
			hardSearchLimit = hardSearchLimit === undefined
				? promptSearchLimit
				: Math.min(hardSearchLimit, promptSearchLimit);
		}
		artifactPaths = [...new Set([...artifactPaths, ...requestedArtifactPaths(event.prompt)])];
		const dynamicRules: string[] = [];
		if (artifactPaths.length > 0) {
			dynamicRules.push(
				`Requested artifact paths: ${artifactPaths.join(", ")}. Create a useful draft as soon as the first defensible result is available and update it incrementally.`,
			);
		}
		if (hardSearchLimit !== undefined) {
			dynamicRules.push(
				`Hard search budget: ${hardSearchLimit} actual queries. Each item in queries[] counts separately. Use the smallest sufficient number; for a two-fact lookup, target two precise queries.`,
			);
		}
		if (dynamicRules.length === 0) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n<bench_dynamic_rules>\n- ${dynamicRules.join("\n- ")}\n</bench_dynamic_rules>`,
		};
	});

	pi.on("tool_call", (event) => {
		const finalizationReason = finalizing ? finalizationBlockReason(event.toolName, event.input) : undefined;
		if (finalizationReason) {
			return {
				block: true,
				reason: `bench-control: finalization window is active; ${finalizationReason}. Write and verify requested artifacts now`,
			};
		}
		if (!SEARCH_TOOL_NAMES.has(event.toolName) || hardSearchLimit === undefined) return undefined;

		const queryCount = countSearchQueries(event.input);
		if (queryCount === 0) return undefined;
		if (searchCount + queryCount > hardSearchLimit) {
			return {
				block: true,
				reason: `bench-control: search budget exceeded (${searchCount}/${hardSearchLimit} already used; this call requests ${queryCount})`,
			};
		}

		searchCount += queryCount;
		pi.appendEntry("bench-control", {
			type: "search-budget",
			used: searchCount,
			limit: hardSearchLimit,
			queriesInCall: queryCount,
		});
		void pi.sendMessage(
			{
				customType: "bench-control",
				content: `Search budget ledger: ${searchCount}/${hardSearchLimit} actual queries used.`,
				display: false,
				details: { used: searchCount, limit: hardSearchLimit, queriesInCall: queryCount },
			},
			{ deliverAs: "steer" },
		).catch(() => {});
		return undefined;
	});
}
