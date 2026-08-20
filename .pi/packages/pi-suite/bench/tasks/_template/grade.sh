#!/usr/bin/env bash
# Grader contract (reward-only):
#   - cwd = the agent's run directory (its copy of workspace/ after the run)
#   - exit 0 = pass, non-zero = fail
#   - stdout/stderr are DISCARDED by the harness; only the exit code is kept.
#     Feel free to print debug detail — the evolve agent will never see it.
set -euo pipefail

test -f report.md
