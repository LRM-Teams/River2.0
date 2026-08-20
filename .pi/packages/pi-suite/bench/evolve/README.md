# Reward-only self-evolution loop for the Pi harness

Runs the benchmark task set for multiple rounds, feeds back **only
PASS / FAIL / TIMEOUT** (never grader output or expected answers), lets an
evolve agent reflect on the eval agent's own traces, and evolves the harness
components under `bench/workspace/`. The base model never changes.

Design sources:

- [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) — the metric
  loop shape: persistent session files, keep/revert on measured signal,
  auto-resumable state on disk.
- [self-harness `feature/reward-only-feedback`](https://github.com/LRM-Teams/self-harness/tree/feature/reward-only-feedback)
  (AHE) — reward-only sanitization, evidence-backed change manifests, and
  falsification by pass/fail flips in the next iteration.

## Loop

```
┌────────────────────────────────────────────────────────────┐
│ iteration N                                                │
│                                                            │
│ run-tasks.sh          reward-only eval of bench/workspace  │
│   → results.json      pass/fail/timeout + wall/tools/turns │
│   → traces/*.jsonl    eval agent's OWN sessions only       │
│                                                            │
│ build-query.mjs       results table + flip table vs N-1    │
│                       + previous change_manifest to falsify│
│                                                            │
│ pi (evolve agent)     edits bench/workspace/* only         │
│   → change_manifest.json  evidence/root-cause/prediction   │
│   → evolution_history.md  one entry per iteration          │
│                                                            │
│ git commit            every iteration auditable/revertible │
└────────────────────────────────────────────────────────────┘
```

## What evolves (and what does not)

| Evolves (`bench/workspace/`) | Fixed |
|---|---|
| `APPEND_SYSTEM.md` system prompt append | model / provider / API params |
| `MEMORY.md` long-term memory card | task prompts and graders |
| `config.json` thinking level + tool exclusions | evolve scripts themselves |
| `skills/<name>/SKILL.md` per-category workflows | |

## Reward-only guarantees

- The runner records the grader **exit code only**; grader stdout/stderr goes
  to `/dev/null` (set `BENCH_KEEP_GRADER_OUTPUT=1` to quarantine it for human
  debugging — the evolve agent is prompt-forbidden from reading it).
- The evolve agent's evidence is limited to `results.json` and the eval
  agent's own session jsonl. `tasks/*/grade.sh` is declared off-limits in the
  prompt, and graders never enter the eval agent's working directory.
- This is a policy boundary (like AHE's), not an OS sandbox.

## Usage

```bash
cd .pi/packages/pi-suite/bench/evolve

# Eval model fixed; evolve model may differ.
export PI_BENCH_PROVIDER=zhizengzeng PI_BENCH_MODEL=gpt-5.5

# 5 iterations on the demo smoke set
./evolve.sh --iterations 5

# Real dataset: point at a directory of task dirs (see bench/tasks/_template)
./evolve.sh --iterations 10 --tasks /path/to/wildclaw-tasks --target 80

# One-off eval without evolving
./run-tasks.sh /tmp/bench-out
```

Runs land in `~/.pi/bench-runs/<timestamp>/iteration_NNN/` (override with
`--runs-dir` / `BENCH_RUNS_DIR`).

Importing real WildClawBench / Claw-Eval tasks = one dir per task with
`task.md` (prompt), `grade.sh` (exit 0 = pass), `timeout`, and `workspace/`
(initial files). Wrap the official checker inside `grade.sh`; the loop only
ever consumes its exit code, so Pass^3-style graders stay hidden.

## Relation to `.auto/` (pi-autoresearch)

`bench/.auto/measure.sh` now calls `run-tasks.sh` on the same task set and
emits `METRIC` lines, so you can alternatively drive experiments interactively
with `pi-autoresearch` (`/autoresearch`) instead of the unattended
`evolve.sh` loop. Same eval, two drivers — never enable either inside the
eval container.
