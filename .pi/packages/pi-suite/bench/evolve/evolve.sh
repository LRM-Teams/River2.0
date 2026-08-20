#!/usr/bin/env bash
set -euo pipefail

# Outer self-evolution loop: evaluate -> reward-only feedback -> evolve -> repeat.
#
#   ./evolve.sh [--iterations N] [--target PCT] [--runs-dir DIR] [--tasks DIR]
#
# Each iteration:
#   1. run-tasks.sh evaluates the current bench/workspace harness on the task
#      set (reward-only: pass/fail/timeout + agent-owned traces).
#   2. A flip table vs the previous iteration is computed and the previous
#      change_manifest.json predictions are surfaced for falsification.
#   3. pi (the evolve agent) reads evolve-prompt.md + the iteration query and
#      edits bench/workspace, then writes change_manifest.json.
#   4. workspace changes are committed (when inside a git repo) so every
#      iteration is auditable and revertible.
#
# Model for the EVOLVE agent: PI_EVOLVE_PROVIDER / PI_EVOLVE_MODEL (defaults
# to the pi default). Model for the EVAL agent: PI_BENCH_PROVIDER /
# PI_BENCH_MODEL (keep fixed across iterations — the harness evolves, not the
# model).

EVOLVE_DIR="$(cd "$(dirname "$0")" && pwd)"
BENCH_DIR="$(cd "$EVOLVE_DIR/.." && pwd)"
PI_BIN="${PI_BIN:-pi}"

ITERATIONS=5
TARGET=""
RUNS_DIR="${BENCH_RUNS_DIR:-$HOME/.pi/bench-runs/$(date +%Y%m%d-%H%M%S)}"
TASKS_DIR="${TASKS_DIR:-$BENCH_DIR/tasks}"
START_ITER=1

while [ "$#" -gt 0 ]; do
	case "$1" in
	--iterations) ITERATIONS="$2" && shift 2 ;;
	--target) TARGET="$2" && shift 2 ;;
	--runs-dir) RUNS_DIR="$2" && shift 2 ;;
	--tasks) TASKS_DIR="$2" && shift 2 ;;
	--start-iteration) START_ITER="$2" && shift 2 ;;
	*) echo "unknown arg: $1" >&2 && exit 1 ;;
	esac
done

mkdir -p "$RUNS_DIR"
RUNS_DIR="$(cd "$RUNS_DIR" && pwd)"
echo "runs dir: $RUNS_DIR"
echo "tasks dir: $TASKS_DIR"

commit_workspace() { # message
	git -C "$BENCH_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
	git -C "$BENCH_DIR" add workspace >/dev/null 2>&1 || return 0
	git -C "$BENCH_DIR" diff --cached --quiet 2>/dev/null && return 0
	git -C "$BENCH_DIR" commit -m "$1" >/dev/null && echo "committed: $1"
}

pass_rate_of() { # results.json -> integer percent (echo)
	node -e '
const r = require(process.argv[1]);
const t = Object.values(r).filter((x) => ["pass", "fail", "timeout"].includes(x.status));
const p = t.filter((x) => x.status === "pass").length;
process.stdout.write(t.length ? String(Math.round((100 * p) / t.length)) : "0");
' "$1"
}

for ((i = START_ITER; i < START_ITER + ITERATIONS; i++)); do
	iter="$(printf 'iteration_%03d' "$i")"
	iter_dir="$RUNS_DIR/$iter"
	prev_dir="$RUNS_DIR/$(printf 'iteration_%03d' $((i - 1)))"
	mkdir -p "$iter_dir"

	echo
	echo "===== $iter: evaluate ====="
	commit_workspace "bench-evolve: snapshot before $iter eval"
	TASKS_DIR="$TASKS_DIR" "$EVOLVE_DIR/run-tasks.sh" "$iter_dir" | tee "$iter_dir/eval.log"

	rate="$(pass_rate_of "$iter_dir/results.json")"
	echo "pass rate: ${rate}%"
	if [ -n "$TARGET" ] && [ "$rate" -ge "$TARGET" ]; then
		echo "target ${TARGET}% reached — stopping."
		break
	fi

	echo "===== $iter: build reward-only query ====="
	ITER="$i" ITER_DIR="$iter_dir" PREV_DIR="$prev_dir" node "$EVOLVE_DIR/build-query.mjs" >"$iter_dir/query.md"

	echo "===== $iter: evolve ====="
	EVOLVE_ARGS=(-p --no-session --append-system-prompt "$EVOLVE_DIR/evolve-prompt.md")
	[ -n "${PI_EVOLVE_PROVIDER:-}" ] && EVOLVE_ARGS+=(--provider "$PI_EVOLVE_PROVIDER")
	[ -n "${PI_EVOLVE_MODEL:-}" ] && EVOLVE_ARGS+=(--model "$PI_EVOLVE_MODEL")
	(cd "$BENCH_DIR" && "$PI_BIN" "${EVOLVE_ARGS[@]}" "$(cat "$iter_dir/query.md")" \
		2>&1 | tee "$iter_dir/evolve.log")

	if [ ! -f "$iter_dir/change_manifest.json" ]; then
		echo "warning: evolve agent wrote no change_manifest.json for $iter" >&2
	fi
	commit_workspace "bench-evolve: $iter changes (pass rate was ${rate}%)"
done

echo
echo "done. history: $BENCH_DIR/evolve/evolution_history.md"
echo "runs: $RUNS_DIR"
