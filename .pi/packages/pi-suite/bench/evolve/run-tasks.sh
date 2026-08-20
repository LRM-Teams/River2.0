#!/usr/bin/env bash
set -euo pipefail

# Reward-only eval runner for the WildClawBench / Claw-Eval evolve loop.
#
# Runs every task under TASKS_DIR with the pi harness described by
# WORKSPACE_DIR, and records ONLY:
#   - status: pass / fail / timeout / error  (grader exit code, nothing else)
#   - wall_seconds, tool_calls, turns        (agent-owned process metadata)
#   - the agent's own session jsonl          (agent-owned trajectory)
#
# Grader stdout/stderr is discarded by default (BENCH_KEEP_GRADER_OUTPUT=1
# quarantines it under <out>/quarantine/ for HUMAN debugging only — the
# evolve agent must never read it).
#
# Task directory contract (one subdir per task under TASKS_DIR):
#   task.md      required  prompt handed to the agent
#   grade.sh     required  run with cwd = the agent's run dir; exit 0 = pass
#   timeout      optional  seconds (default $BENCH_TASK_TIMEOUT or 600)
#   workspace/   optional  files copied into the agent's run dir before start
#
# Usage: run-tasks.sh <out_dir> [task_name ...]
#   env: TASKS_DIR, WORKSPACE_DIR, PI_BENCH_PROVIDER, PI_BENCH_MODEL,
#        BENCH_TASK_TIMEOUT, BENCH_KEEP_GRADER_OUTPUT, PI_BIN

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TASKS_DIR="${TASKS_DIR:-$BENCH_DIR/tasks}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$BENCH_DIR/workspace}"
PI_BIN="${PI_BIN:-pi}"
BENCH_TASK_TIMEOUT="${BENCH_TASK_TIMEOUT:-600}"

OUT_DIR="${1:?usage: run-tasks.sh <out_dir> [task ...]}"
shift || true
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

if [ "$#" -gt 0 ]; then
	TASKS=("$@")
else
	TASKS=()
	for d in "$TASKS_DIR"/*/; do
		name="$(basename "$d")"
		[ "${name#_}" = "$name" ] || continue # skip _template etc.
		[ -f "$d/task.md" ] || continue
		TASKS+=("$name")
	done
fi
if [ "${#TASKS[@]}" -eq 0 ]; then
	echo "no tasks found under $TASKS_DIR" >&2
	exit 1
fi

# Harness config produced by the evolve loop (bench/workspace/config.json).
CFG="$WORKSPACE_DIR/config.json"
THINKING="$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.thinking||"")' "$CFG" 2>/dev/null || true)"
EXCLUDE_TOOLS="$(node -e 'const c=require(process.argv[1]);process.stdout.write((c.excludeTools||[]).join(","))' "$CFG" 2>/dev/null || true)"

# Note: sessions must be saved (they are the agent-owned trace we feed back).
PI_ARGS=(-p)
[ -n "${PI_BENCH_PROVIDER:-}" ] && PI_ARGS+=(--provider "$PI_BENCH_PROVIDER")
[ -n "${PI_BENCH_MODEL:-}" ] && PI_ARGS+=(--model "$PI_BENCH_MODEL")
[ -n "$THINKING" ] && PI_ARGS+=(--thinking "$THINKING")
[ -n "$EXCLUDE_TOOLS" ] && PI_ARGS+=(--exclude-tools "$EXCLUDE_TOOLS")
[ -f "$WORKSPACE_DIR/APPEND_SYSTEM.md" ] && PI_ARGS+=(--append-system-prompt "$WORKSPACE_DIR/APPEND_SYSTEM.md")
[ -f "$WORKSPACE_DIR/MEMORY.md" ] && PI_ARGS+=(--append-system-prompt "$WORKSPACE_DIR/MEMORY.md")
if [ -d "$WORKSPACE_DIR/skills" ]; then
	for s in "$WORKSPACE_DIR/skills"/*/; do
		[ -f "$s/SKILL.md" ] && PI_ARGS+=(--skill "$s")
	done
fi

mkdir -p "$OUT_DIR/traces"
RESULTS="$OUT_DIR/results.json"
echo '{}' >"$RESULTS"

record() { # task status wall tool_calls turns
	node -e '
const fs = require("node:fs");
const [file, task, status, wall, toolCalls, turns] = process.argv.slice(1);
const r = JSON.parse(fs.readFileSync(file, "utf8"));
r[task] = { status, wall_seconds: Number(wall), tool_calls: Number(toolCalls), turns: Number(turns) };
fs.writeFileSync(file, JSON.stringify(r, null, 2) + "\n");
' "$RESULTS" "$@"
}

for task in "${TASKS[@]}"; do
	tdir="$TASKS_DIR/$task"
	if [ ! -f "$tdir/task.md" ]; then
		echo "[$task] missing task.md, skipping" >&2
		record "$task" error 0 0 0
		continue
	fi
	run="$OUT_DIR/tasks/$task"
	rm -rf "$run"
	mkdir -p "$run/work" "$run/session"
	[ -d "$tdir/workspace" ] && cp -a "$tdir/workspace/." "$run/work/"

	tmo="$BENCH_TASK_TIMEOUT"
	[ -f "$tdir/timeout" ] && tmo="$(tr -dc '0-9' <"$tdir/timeout")"

	echo "[$task] running (timeout ${tmo}s)"
	start="$(date +%s)"
	set +e
	(cd "$run/work" && timeout -k 30 "$tmo" \
		"$PI_BIN" "${PI_ARGS[@]}" --session-dir "$run/session" \
		"$(cat "$tdir/task.md")" >"$run/agent-stdout.txt" 2>&1)
	agent_rc=$?
	set -e
	wall=$(($(date +%s) - start))

	# Agent-owned process metadata from its own session jsonl.
	sess="$(ls -t "$run/session"/*.jsonl 2>/dev/null | head -1 || true)"
	tool_calls=0 turns=0
	if [ -n "$sess" ]; then
		cp "$sess" "$OUT_DIR/traces/$task.jsonl"
		tool_calls="$(grep -c '"type":"toolCall"' "$sess" || true)"
		turns="$(grep -c '"role":"assistant"' "$sess" || true)"
	fi

	if [ "$agent_rc" -eq 124 ] || [ "$agent_rc" -eq 137 ]; then
		record "$task" timeout "$wall" "$tool_calls" "$turns"
		echo "[$task] TIMEOUT after ${wall}s"
		continue
	fi

	# Reward-only: keep the grader exit code, drop its output.
	if [ ! -f "$tdir/grade.sh" ]; then
		record "$task" ungraded "$wall" "$tool_calls" "$turns"
		echo "[$task] no grade.sh — recorded as ungraded"
		continue
	fi
	if [ "${BENCH_KEEP_GRADER_OUTPUT:-0}" = "1" ]; then
		mkdir -p "$OUT_DIR/quarantine"
		gout="$OUT_DIR/quarantine/$task.grader.txt"
	else
		gout=/dev/null
	fi
	set +e
	(cd "$run/work" && bash "$tdir/grade.sh" >"$gout" 2>&1)
	grade_rc=$?
	set -e

	if [ "$grade_rc" -eq 0 ]; then
		record "$task" pass "$wall" "$tool_calls" "$turns"
		echo "[$task] PASS (${wall}s, ${tool_calls} tool calls)"
	else
		record "$task" fail "$wall" "$tool_calls" "$turns"
		echo "[$task] FAIL (${wall}s, ${tool_calls} tool calls)"
	fi
done

# Summary line for drivers (evolve.sh / measure.sh).
node -e '
const r = require(process.argv[1]);
const t = Object.values(r);
const pass = t.filter((x) => x.status === "pass").length;
const graded = t.filter((x) => ["pass", "fail", "timeout"].includes(x.status)).length;
const safetyFail = Object.entries(r).filter(
  ([name, x]) => /safety/i.test(name) && x.status !== "pass" && x.status !== "ungraded",
).length;
const wall = t.reduce((a, x) => a + (x.wall_seconds || 0), 0);
const calls = t.reduce((a, x) => a + (x.tool_calls || 0), 0);
console.log(
  `SUMMARY pass=${pass} graded=${graded} pass_rate=${graded ? ((100 * pass) / graded).toFixed(1) : 0} wall_min=${(wall / 60).toFixed(1)} tool_calls=${calls} safety_fail=${safetyFail}`,
);
' "$RESULTS"
