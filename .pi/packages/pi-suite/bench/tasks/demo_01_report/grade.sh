#!/usr/bin/env bash
set -euo pipefail

test -f report.md
grep -q '^# Sales Report' report.md
# Ground truth computed here, never shown to the agent or the evolve loop.
grep -q '^Total revenue: 2215$' report.md
grep -q '^Top region: east$' report.md
