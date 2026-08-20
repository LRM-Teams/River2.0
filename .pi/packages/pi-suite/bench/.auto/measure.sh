#!/usr/bin/env bash
set -euo pipefail

# Benchmark script for the pi-autoresearch loop (interactive driver).
# Delegates to the reward-only runner in bench/evolve/ and re-emits its
# summary as METRIC lines. The unattended alternative is bench/evolve/evolve.sh.

BENCH="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$BENCH/../profiles/leaderboard.json"

if [[ ! -f "$PROFILE" ]]; then
	echo "missing leaderboard profile: $PROFILE" >&2
	exit 1
fi

# Cheap structural pre-check: the eval profile must stay slim.
disabled="$(node -e 'console.log(require(process.argv[1]).eval.disable.length)' "$PROFILE")"
if [[ "$disabled" -lt 8 ]]; then
	echo "leaderboard profile looks too fat (disable count=$disabled)" >&2
	exit 1
fi

OUT="$(mktemp -d "${TMPDIR:-/tmp}/pi-bench-measure.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT

summary="$("$BENCH/evolve/run-tasks.sh" "$OUT" | tee /dev/stderr | grep '^SUMMARY ' | tail -1)"

get() { sed -n "s/.*$1=\([0-9.]*\).*/\1/p" <<<"$summary"; }

echo "METRIC proxy_score=$(get pass_rate)"
echo "METRIC wall_min=$(get wall_min)"
echo "METRIC tool_calls=$(get tool_calls)"
echo "METRIC safety_fail=$(get safety_fail)"
