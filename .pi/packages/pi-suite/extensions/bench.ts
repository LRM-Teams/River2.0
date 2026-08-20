// /bench — drive the reward-only bench harness from inside pi.
//
//   /bench                 status: running loop, latest results, history tail
//   /bench run [task ...]  one-off eval of bench/tasks (background)
//   /bench evolve [N]      start the self-evolution loop for N iterations (background)
//   /bench stop            stop the running eval/evolve process
//   /bench tasks           list available task directories
//
// The heavy lifting stays in bench/evolve/*.sh; this extension only
// starts/stops those scripts detached and reports their state. It is an
// operator command — it registers no model-visible tools and must stay
// disabled inside eval containers (see profiles/leaderboard.json).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BENCH_DIR = fileURLToPath(new URL("../bench", import.meta.url));
const STATE_DIR = join(homedir(), ".pi", "bench-runs");
const PID_FILE = join(STATE_DIR, "current.pid");
const META_FILE = join(STATE_DIR, "current.json");
const LOG_FILE = join(STATE_DIR, "current.log");

interface RunMeta {
	mode: "run" | "evolve";
	startedAt: string;
	runsDir: string;
	args: string[];
}

function readMeta(): RunMeta | undefined {
	try {
		return JSON.parse(readFileSync(META_FILE, "utf8")) as RunMeta;
	} catch {
		return undefined;
	}
}

function runningPid(): number | undefined {
	try {
		const pid = Number(readFileSync(PID_FILE, "utf8").trim());
		if (!Number.isFinite(pid) || pid <= 0) return undefined;
		process.kill(pid, 0);
		return pid;
	} catch {
		return undefined;
	}
}

function listTasks(): string[] {
	const tasksDir = join(BENCH_DIR, "tasks");
	if (!existsSync(tasksDir)) return [];
	return readdirSync(tasksDir)
		.filter((name) => !name.startsWith("_") && !name.startsWith("."))
		.filter((name) => existsSync(join(tasksDir, name, "task.md")))
		.sort();
}

function startDetached(mode: RunMeta["mode"], command: string, args: string[], runsDir: string): number {
	mkdirSync(STATE_DIR, { recursive: true });
	rmSync(LOG_FILE, { force: true });
	const log = openSync(LOG_FILE, "a");
	const child = spawn(command, args, {
		cwd: join(BENCH_DIR, "evolve"),
		detached: true,
		stdio: ["ignore", log, log],
		env: {
			...process.env,
			PI_BENCH_CHILD: "1",
			PI_MEMORY_FINALIZE: process.env.PI_MEMORY_FINALIZE ?? "0",
			PI_MEMORY_SKILL_DRAFTS: process.env.PI_MEMORY_SKILL_DRAFTS ?? "off",
		},
	});
	child.unref();
	const pid = child.pid ?? 0;
	writeFileSync(PID_FILE, `${pid}\n`);
	const meta: RunMeta = { mode, startedAt: new Date().toISOString(), runsDir, args };
	writeFileSync(META_FILE, `${JSON.stringify(meta, null, 2)}\n`);
	return pid;
}

function latestResults(runsDir: string): { path: string; summary: string } | undefined {
	try {
		const iterations = readdirSync(runsDir)
			.filter((name) => name.startsWith("iteration_"))
			.sort();
		for (const iteration of iterations.reverse()) {
			const file = join(runsDir, iteration, "results.json");
			if (!existsSync(file)) continue;
			const results = JSON.parse(readFileSync(file, "utf8")) as Record<
				string,
				{ status: string; wall_seconds: number; tool_calls: number }
			>;
			const rows = Object.entries(results).map(
				([task, r]) => `  ${r.status === "pass" ? "✓" : "✗"} ${task} — ${r.status} (${r.wall_seconds}s, ${r.tool_calls} tools)`,
			);
			const graded = Object.values(results).filter((r) => ["pass", "fail", "timeout"].includes(r.status));
			const pass = graded.filter((r) => r.status === "pass").length;
			return {
				path: file,
				summary: `${iteration}: ${pass}/${graded.length} pass\n${rows.join("\n")}`,
			};
		}
	} catch {
		// fall through
	}
	return undefined;
}

function tailFile(path: string, lines: number): string {
	try {
		const content = readFileSync(path, "utf8").trimEnd().split("\n");
		return content.slice(-lines).join("\n");
	} catch {
		return "";
	}
}

export default function benchExtension(pi: ExtensionAPI): void {
	// Never register inside a bench child (the eval/evolve pi processes).
	if (process.env.PI_BENCH_CHILD === "1") return;

	pi.registerCommand("bench", {
		description: "Bench harness: /bench [status|run [task ...]|evolve [N]|stop|tasks]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = words[0] ?? "status";

			if (sub === "tasks") {
				const tasks = listTasks();
				ctx.ui.notify(tasks.length ? `bench tasks (${tasks.length}):\n  ${tasks.join("\n  ")}` : "no tasks under bench/tasks/", "info");
				return;
			}

			if (sub === "stop") {
				const pid = runningPid();
				if (!pid) {
					ctx.ui.notify("no bench process running.", "info");
					return;
				}
				// The runner is a session leader (detached spawn); kill the whole
				// session — GNU timeout re-groups its children, so a plain group
				// kill would leave the eval pi running.
				const killed = await pi.exec("pkill", ["-TERM", "-s", String(pid)], { timeout: 10_000 }).catch(() => undefined);
				if (!killed || killed.code > 1) {
					try {
						process.kill(-pid, "SIGTERM");
					} catch {
						process.kill(pid, "SIGTERM");
					}
				}
				rmSync(PID_FILE, { force: true });
				ctx.ui.notify(`stopped bench process ${pid}. Partial results stay in ${readMeta()?.runsDir ?? STATE_DIR}.`, "info");
				return;
			}

			if (sub === "run" || sub === "evolve") {
				if (runningPid()) {
					ctx.ui.notify("a bench process is already running — /bench for status or /bench stop first.", "warning");
					return;
				}
				const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
				if (sub === "run") {
					const runsDir = join(STATE_DIR, `run-${stamp}`);
					mkdirSync(join(runsDir, "iteration_001"), { recursive: true });
					const tasks = words.slice(1);
					const pid = startDetached("run", join(BENCH_DIR, "evolve", "run-tasks.sh"), [join(runsDir, "iteration_001"), ...tasks], runsDir);
					ctx.ui.notify(`bench eval started (pid ${pid})${tasks.length ? ` tasks: ${tasks.join(", ")}` : " (all tasks)"} — /bench for status.`, "info");
				} else {
					const iterations = /^\d+$/.test(words[1] ?? "") ? words[1] : "5";
					const runsDir = join(STATE_DIR, `evolve-${stamp}`);
					const pid = startDetached("evolve", join(BENCH_DIR, "evolve", "evolve.sh"), ["--iterations", iterations, "--runs-dir", runsDir], runsDir);
					ctx.ui.notify(`self-evolution loop started (pid ${pid}, ${iterations} iterations) — /bench for status, /bench stop to abort.`, "info");
				}
				return;
			}

			// status (default)
			const pid = runningPid();
			const meta = readMeta();
			const parts: string[] = [];
			parts.push(pid ? `RUNNING: ${meta?.mode ?? "?"} (pid ${pid}, since ${meta?.startedAt ?? "?"})` : "idle — no bench process running.");
			if (meta?.runsDir) {
				const latest = latestResults(meta.runsDir);
				if (latest) parts.push(latest.summary);
			}
			const logTail = tailFile(LOG_FILE, 6);
			if (logTail) parts.push(`log tail:\n${logTail}`);
			const history = tailFile(join(BENCH_DIR, "evolve", "evolution_history.md"), 6);
			if (history) parts.push(`history tail:\n${history}`);
			ctx.ui.notify(parts.join("\n\n"), "info");
		},
	});
}
