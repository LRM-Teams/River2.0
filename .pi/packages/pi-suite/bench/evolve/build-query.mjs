// Builds the reward-only iteration query for the evolve agent.
// env: ITER, ITER_DIR, PREV_DIR (previous iteration dir, may not exist)
import fs from "node:fs";
import path from "node:path";

const iter = Number(process.env.ITER);
const iterDir = process.env.ITER_DIR;
const prevDir = process.env.PREV_DIR;

const readJson = (p) => {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
};

const results = readJson(path.join(iterDir, "results.json")) ?? {};
const prevResults = prevDir ? (readJson(path.join(prevDir, "results.json")) ?? null) : null;
const prevManifest = prevDir ? readJson(path.join(prevDir, "change_manifest.json")) : null;

const rows = Object.entries(results).sort(([a], [b]) => a.localeCompare(b));
const graded = rows.filter(([, r]) => ["pass", "fail", "timeout"].includes(r.status));
const passed = graded.filter(([, r]) => r.status === "pass");

const lines = [];
lines.push(`# Iteration ${iter} evaluation completed (reward-only feedback)`);
lines.push("");
lines.push(
	`Pass rate: ${passed.length}/${graded.length}` +
		(graded.length ? ` (${((100 * passed.length) / graded.length).toFixed(1)}%)` : ""),
);
lines.push("");
lines.push("| task | status | wall_s | tool_calls | turns |");
lines.push("|---|---|---|---|---|");
for (const [name, r] of rows) {
	lines.push(`| ${name} | ${r.status.toUpperCase()} | ${r.wall_seconds} | ${r.tool_calls} | ${r.turns} |`);
}

if (prevResults) {
	const flips = [];
	for (const [name, r] of rows) {
		const prev = prevResults[name];
		if (!prev) continue;
		const was = prev.status === "pass" ? "pass" : "fail";
		const now = r.status === "pass" ? "pass" : "fail";
		if (was !== now) flips.push(`- ${name}: ${was} -> ${now}`);
	}
	lines.push("");
	lines.push(`## Flips vs iteration ${iter - 1}`);
	lines.push(flips.length ? flips.join("\n") : "(none)");
}

if (prevManifest?.changes?.length) {
	lines.push("");
	lines.push(`## Your iteration ${iter - 1} change manifest (falsify these predictions)`);
	lines.push("```json");
	lines.push(JSON.stringify(prevManifest, null, 2));
	lines.push("```");
}

lines.push("");
lines.push("## Evidence available to you");
lines.push(`- \`${path.join(iterDir, "results.json")}\` — statuses and process metadata (shown above)`);
lines.push(`- \`${path.join(iterDir, "traces")}/*.jsonl\` — the eval agent's own session per task`);
lines.push("");
lines.push("## Your job now");
lines.push("1. Analyze failed/timed-out tasks from the traces (behavioral defects only).");
if (prevManifest?.changes?.length) {
	lines.push("2. Verdict each previous change: KEEP / IMPROVE / ROLLBACK+PIVOT, based on the flip table.");
}
lines.push(`${prevManifest?.changes?.length ? 3 : 2}. Make evidence-backed edits under \`workspace/\` only.`);
lines.push(
	`${prevManifest?.changes?.length ? 4 : 3}. Write \`${path.join(iterDir, "change_manifest.json")}\` (iteration = ${iter}) and append to \`evolve/evolution_history.md\`.`,
);
lines.push("");
lines.push(
	"Reminder: reward-only. Do not read tasks/*/grade.sh or any quarantine/ directory. Do not hardcode task-specific answers.",
);

process.stdout.write(`${lines.join("\n")}\n`);
