# Pi vs OpenClaw on WildClawBench / Claw-Eval

Branch: `feat/bench-wildclaw-claweval`

Default install on this branch writes Lenovo DeepSeek (`lenovo-deepseek-v4-flash` / `DeepSeek-V4-Flash-0731`) to `~/.pi/agent`. Key is typed at install time. Base URL matches the local ModelFactory endpoint. Old claude-code.club leftover is `scripts/bootstrap.legacy.sh`.

This is the harness-tuning track. The model stays fixed. The +2 target is **absolute overall points** on the same tasks and grader as OpenClaw.

## What `pi-autoresearch` is

Source: https://github.com/davebcn87/pi-autoresearch (`pi-autoresearch@1.6.2`)

It is a **metric loop**, not a task agent.

| Piece | Role |
|---|---|
| `init_experiment` / `run_experiment` / `log_experiment` | Run a command, parse `METRIC name=value`, keep or revert |
| `.auto/prompt.md` + `.auto/log.jsonl` | Survive compaction and new sessions |
| Confidence score | Best gain vs session noise; `<1.0×` is within noise |
| Skills | `autoresearch-create`, `autoresearch-finalize`, `autoresearch-hooks` |
| Auto-resume | After compact, re-read `.auto/` and continue, cap 200 turns / 20 consecutive fails |

Use it **between** eval runs to change the harness. Do **not** load it inside the WildClaw / Claw-Eval container. Those tasks already burn ~8 minutes and 20+ tools; an inner experiment loop will miss the wall-clock budget.

Install for the evolve machine only:

```bash
pi install npm:pi-autoresearch
```

Session files for this track live at `.pi/packages/pi-suite/bench/.auto/`.

## Why this can move +2

WildClawBench (InternLM, 60 tasks, 4 official harnesses):

- OpenClaw top: GPT-5.6 Sol **67.2%**
- Same model, different harness: up to **~18 points** (paper) / **6–8 points** on the published table (GPT-5.4 Codex 56.8 vs OpenClaw 50.3; MiMo V2 Pro Hermes 48.1 vs OpenClaw 40.2)
- Categories that punish a fat harness: long-horizon productivity, search reconciliation, code-from-source, safety

Claw-Eval (claw-eval/claw-eval, 300 tasks, Pass^3):

- Grades **completion / safety / robustness** on full traces
- Lucky single passes do not count
- Extra tools and flaky memory writes hurt Pass^3 more than Pass@1

A +2 overall on WildClaw is about **one extra full-pass task**. The cheap way to get that is to stop wasting tools, not to add another autonomous loop.

## Official path vs OpenClaw

WildClawBench does **not** ship a Pi image. Official harnesses are OpenClaw, Claude Code, Codex CLI, Hermes Agent.

Two ways to compare:

1. **Harbor** — `internlm/WildClawBench-Harbor` already supports any Harbor agent. Add a Pi Harbor adapter. This is the fastest fair compare.
2. **Native** — clone their `script/run.sh` / `eval/run_batch.py` pattern and add a fifth `pi` Docker image. Heavier, closer to their paper pipeline.

Claw-Eval path: their `Dockerfile.agent` + EvalScope. Add a Pi agent image that talks to the mock services (gmail, calendar, web, …).

Do not try to “look like OpenClaw” by stuffing OpenClaw skills into Pi. Grade the **Pi harness**.

## Module verdict

### Remove from the eval profile

These cost tokens or steal the turn budget and do not help graders.

| Module | Why drop |
|---|---|
| `tps.ts` | Notifications. No score signal. |
| `prompt-url-widget.ts` | Editor chrome. |
| `autogoal.ts` | Second autonomous loop. Conflicts with the bench runner and with autoresearch. |
| `goal-mode.ts` | Third loop. Overlaps autogoal. |
| `pi-suite-repair.ts` | Install helper. Not a task tool. |
| `prompts/{cl,commit,is,pr,review,wr}.md` | Team git workflows. Wrong prior for email / search / safety tasks. |
| `skills/skill-creator` | Meta skill authoring. |
| `skills/add-llm-provider` | Setup only. |
| `skills/image-to-editable-ppt-slide` | Narrow. Only turn on for a creative-synthesis replay if needed. |
| `skills/pi-skill` | Long capability dump. Inflates context. |
| `pi-subagents` | Extra agents burn the 300–1200s budget; WildClaw tasks are single-agent. |
| `pi-mono-figma` | Already off. Keep off. |
| `pi-autoresearch` | Offline only. |

### Keep in the eval profile

| Module | Why keep | Change |
|---|---|---|
| Core Pi tools | Shell / files are the actual interface | Leave |
| `update-plan.ts` | Long-horizon (10–20 min, 10–60 tools) | Keep the tool, shorten the “use this for 3+ steps” nag |
| `pi-web-access` | Search & retrieval, paper digest | Keep |
| `@lebronj/pi-lsp` | Code Intelligence (undocumented repo, SAM3) | Keep; do not auto-start every language server |
| `@lebronj/pi-playwright` | Browser / multimodal | Keep; publish the missing 0.0.1→0.0.2 evaluate fix before image bake |
| `pi-memory` read path | Short “how we fail on this bench” card | **Strip write/curator/share/downflow/version/profile tools during eval** |

### Optimize, do not delete

| Module | Problem on the bench | Change |
|---|---|---|
| `pi-memory` | Too many tools; detached worker already default-off | Env `PI_MEMORY_BENCH=1`: register `memory_read` + lexical `memory_search` only. Inject at most one compact MEMORY.md. |
| `update-plan` | Prompt injection on every 3-step task | Only inject when the user/task text is long-horizon (email rounds, 50-paper crawl). |
| Compaction | WildClaw is long-horizon | Keep Pi auto-compact; do not also run autogoal session-switch. |
| Companion install | Suite + standalone duplicates | Leaderboard image installs companions once, never via `/pi-suite-repair`. |

## Recommended two-phase setup

**Phase A — eval image (this branch’s `package.leaderboard.json`)**

```text
update-plan + memory(read/search) + pi-web-access + pi-lsp + pi-playwright
```

**Phase B — evolve machine**

```text
full suite + npm:pi-autoresearch
metric = smoke-set score
keep only if primary rises and safety_fail does not
```

Smoke set (first proxy, replace with Harbor when the adapter exists):

- WildClaw: 1 productivity, 1 code, 1 search, 1 safety, 1 social, 1 creative
- Claw-Eval: 12 `general` tasks, Pass@1 while iterating, Pass^3 only for the claimed +2

## Reward-only self-evolution loop (`bench/evolve/`)

Implemented after studying [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch)
(metric loop, persistent `.auto/` state) and
[self-harness `feature/reward-only-feedback`](https://github.com/LRM-Teams/self-harness/tree/feature/reward-only-feedback)
(AHE: reward-only sanitization, change manifests, flip falsification).

- `bench/evolve/evolve.sh` — unattended outer loop: eval → reward-only
  feedback → evolve agent edits `bench/workspace/` → git commit → next round.
- Feedback per task is PASS/FAIL/TIMEOUT + wall seconds + tool calls + the
  agent's own session jsonl. Grader output is discarded; expected answers
  never reach the evolve agent.
- Every change carries evidence, root cause, and predicted flips; the next
  iteration's flip table falsifies the prediction (KEEP / IMPROVE /
  ROLLBACK+PIVOT).
- `bench/.auto/measure.sh` calls the same runner and emits `METRIC` lines, so
  `pi-autoresearch` can drive the same experiments interactively.

See `bench/evolve/README.md` for the task-dir contract and usage.

## Next implementation slices

1. Memory bench-mode tool filter (`PI_MEMORY_BENCH=1`).
2. Harbor Pi adapter under `bench/harness/`.
3. Bake a Docker image that installs `@lebronj/pi-suite` from `package.leaderboard.json`.
4. Run OpenClaw and Pi on the same model, same 8-task smoke set, lock the baseline.
5. Import real WildClaw / Claw-Eval tasks into `bench/tasks/` (wrap official checkers in `grade.sh`) and run `bench/evolve/evolve.sh` for multi-round reward-only evolution.
6. Alternatively start `/skill:autoresearch-create` pointed at `.pi/packages/pi-suite/bench/.auto` for interactive tuning.
