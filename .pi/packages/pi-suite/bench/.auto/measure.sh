#!/usr/bin/env bash
set -euo pipefail

# Offline proxy for the autoresearch loop.
# Replace the echo stubs with a real Harbor / EvalScope smoke run once the Pi
# harness image exists. Keep this script faster than a full 60-task sweep.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$ROOT/../profiles/leaderboard.json"

if [[ ! -f "$PROFILE" ]]; then
	echo "missing leaderboard profile: $PROFILE" >&2
	exit 1
fi

# Cheap structural pre-check: the eval profile must stay slim.
disabled="$(python3 - <<'PY' "$PROFILE"
import json, sys
profile = json.load(open(sys.argv[1]))
print(len(profile["eval"]["disable"]))
PY
)"

if [[ "$disabled" -lt 8 ]]; then
	echo "leaderboard profile looks too fat (disable count=$disabled)" >&2
	exit 1
fi

# TODO: harbor run --agent pi --dataset internlm/WildClawBench-Harbor --n 8
# TODO: evalscope eval --suite claw-eval --split general --limit 12 --pass-k 1
proxy_score="${PROXY_SCORE:-0}"
wall_min="${PROXY_WALL_MIN:-0}"
tool_calls="${PROXY_TOOL_CALLS:-0}"
safety_fail="${PROXY_SAFETY_FAIL:-0}"

echo "METRIC proxy_score=${proxy_score}"
echo "METRIC wall_min=${wall_min}"
echo "METRIC tool_calls=${tool_calls}"
echo "METRIC safety_fail=${safety_fail}"
