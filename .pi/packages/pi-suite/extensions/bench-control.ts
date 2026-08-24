/**
 * bench-control: deadline and search-budget discipline for unattended eval runs.
 *
 * The runner provides PI_BENCH_DEADLINE_EPOCH (Unix seconds). This extension
 * steers the agent into artifact finalization before the outer hard timeout and
 * enforces explicit search limits found in the task prompt.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SEARCH_TOOL_NAMES = new Set(["web_search", "websearch", "search", "search_query", "internet_search"]);
const DEFAULT_FINALIZE_SECONDS = 90;

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
	if (Array.isArray(input.queries)) {
		return input.queries.filter((query) => {
			if (typeof query === "string") return query.trim().length > 0;
			if (!query || typeof query !== "object") return false;
			const candidate = query as Record<string, unknown>;
			const value = candidate.q ?? candidate.query;
			return typeof value === "string" && value.trim().length > 0;
		}).length;
	}
	return typeof input.query === "string" && input.query.trim().length > 0 ? 1 : 0;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requestedArtifactPaths(prompt: string): string[] {
	const matches = prompt.match(/\/tmp_workspace\/[A-Za-z0-9_./-]+/g) ?? [];
	return [...new Set(matches.filter((candidate) => /\.[A-Za-z0-9]{1,8}$/.test(candidate)))].slice(0, 8);
}

export default function benchControlExtension(pi: ExtensionAPI): void {
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let hardSearchLimit: number | undefined;
	let searchCount = 0;
	let finalizing = false;

	const clearDeadlineTimer = (): void => {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		deadlineTimer = undefined;
	};

	pi.on("session_start", () => {
		clearDeadlineTimer();
		hardSearchLimit = undefined;
		searchCount = 0;
		finalizing = false;

		const deadlineEpoch = Number(process.env.PI_BENCH_DEADLINE_EPOCH);
		if (!Number.isFinite(deadlineEpoch) || deadlineEpoch <= 0) return;
		const finalizeSeconds = parsePositiveInteger(
			process.env.PI_BENCH_FINALIZE_SECONDS,
			DEFAULT_FINALIZE_SECONDS,
		);
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
		clearDeadlineTimer();
	});

	pi.on("before_agent_start", (event) => {
		if (finalizing) return undefined;
		hardSearchLimit = parseSearchLimit(event.prompt);
		searchCount = 0;
		const artifactPaths = requestedArtifactPaths(event.prompt);
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
		if (finalizing && (SEARCH_TOOL_NAMES.has(event.toolName) || event.toolName === "gemini_vision")) {
			return {
				block: true,
				reason: "bench-control: finalization window is active; write and verify requested artifacts now",
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
