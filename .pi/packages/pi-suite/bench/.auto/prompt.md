# Autoresearch: WildClawBench / Claw-Eval harness lift

## Objective

Raise Pi harness overall score by **+2 absolute points** against the same model on OpenClaw.
This loop edits the **harness** (prompts, tool set, skills, memory injection, timeouts), not the benchmark tasks.

Do **not** install or enable `pi-autoresearch` inside the eval container. Autoresearch is the offline optimizer only.

## Metrics

- **Primary**: `proxy_score` (percent, higher is better) — mean score on the smoke task set in `.auto/measure.sh`
- **Secondary**: `wall_min` (minutes, lower), `tool_calls` (count, lower if score holds), `safety_fail` (count, lower)

A +2 overall on the full 60-task WildClawBench suite is about 1 extra full-pass task. Treat a **+2 on the 8-task smoke set** as the keep threshold only if it is stable across 2 repeats; otherwise require the full category replay before `keep`.

## How to Run

`./.auto/measure.sh` — outputs `METRIC name=number` lines.

## Files in Scope

- `.pi/packages/pi-suite/bench/workspace/**` (APPEND_SYSTEM.md, MEMORY.md, config.json, skills/) — preferred surface, same one the evolve.sh loop edits
- `.pi/packages/pi-suite/profiles/leaderboard.json`
- `.pi/packages/pi-suite/package.leaderboard.json`
- `.pi/packages/pi-suite/extensions/update-plan.ts`
- `.pi/packages/pi-suite/vendor/pi-memory/**` (read-path and tool registration only)
- Future: Harbor / EvalScope Pi adapter under `bench/harness/`

Reward-only: never read `bench/tasks/*/grade.sh` or quarantine dirs; evidence is `results.json`, artifact manifests, and agent-owned traces only (see `bench/evolve/README.md`).

## Off Limits

- Benchmark task prompts, graders, and ground truth
- Enabling pet / snake / TPS / URL widget / Figma during eval
- Running autogoal, goal-mode, and autoresearch at the same time
- Publishing `@jhp/pi-memory` (scope is not ours)

## Constraints

- Eval budget is 300–1200s and ~20+ tool calls per WildClaw task. Extra tools burn the budget.
- Memory during eval: `memory_read` + lexical `memory_search` only. No curator, share, downflow, or version push.
- Safety category must not regress. A smoke-score gain that adds `safety_fail` is a discard.
- Same model id as the OpenClaw baseline. Do not swap models to fake the +2.

## What's Been Tried

- (fill after first baseline)
