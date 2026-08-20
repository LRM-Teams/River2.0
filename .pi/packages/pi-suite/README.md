# @lebronj/pi-suite

Slim Pi suite for WildClawBench / Claw-Eval. Default install profile is Lenovo ModelFactory DeepSeek; the bench profile (`TEAM_PROFILE=zhizengzeng`) provisions GPT-5.5 as the main model plus Gemini vision tools.

Team toys (pet / snake / TPS), autogoal / goal-mode, git prompts, and subagents are **not** loaded on this branch. See `docs/bench/LEADERBOARD.md`.

## Install

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install npm:@lebronj/pi-suite
pi install npm:pi-web-access
pi install npm:@lebronj/pi-lsp
```

Or bootstrap Pi, write the DeepSeek provider, and install the slim suite. The script asks for the API key on the terminal; it does not ship a key.

```bash
curl -fsSL https://registry.npmjs.org/@lebronj/pi-suite/-/pi-suite-0.1.38.tgz | tar -xzO package/scripts/bootstrap.sh | bash
```

Defaults written to `~/.pi/agent/models.json` / `settings.json`:

- Provider: `lenovo-deepseek-v4-flash`
- Base URL: `https://modelfactory.lenovo.com/service-large-600-1777255649450/llm/v1`
- API: `openai-completions`
- Default model: `DeepSeek-V4-Flash-0731`

Override with `TEAM_BASE_URL`, `TEAM_MODEL`, or `TEAM_API_KEY`. Old claude-code.club / gpt-5.5 leftover: `TEAM_PROFILE=legacy` (see `scripts/bootstrap.legacy.sh`).

### Bench profile: GPT-5.5 + Gemini vision

```bash
TEAM_PROFILE=zhizengzeng ZHIZENGZENG_API_KEY=sk-... bash scripts/bootstrap.sh
```

Writes the `zhizengzeng` provider (`https://api.zhizengzeng.com/v1`) with:

- `gpt-5.5` / `gpt-5.5-pro` — main control, Responses API (chat completions rejects tools + `reasoning_effort` for these models), text+image input.
- `gemini-3.1-pro-preview` — vision fallback model, chat completions.
- `~/.pi/agent/media-tools.json` — key + base URL for the `gemini_vision` tool below.

## What Is Included

- `update_plan` for long-horizon checklists.
- Media tools (`extensions/media-tools.ts`), backed by Zhizengzeng's Google-native gateway (`/google/v1beta`):
  - `gemini_vision(paths, question)` — images, whole videos (audio track included, timestamp-aware, MM:SS), and audio files. Oversized videos are transcoded down with ffmpeg; frame sampling is the last resort. `smartCrop=true` zooms into the relevant image region (two-pass crop-and-reask). `startSeconds`/`durationSeconds` clip long videos.
  - `video_frames` — extract frames to files: fixed interval, exact timestamps, or scene-change detection.
  - `image_crop` — crop/resize an image with ffmpeg.
  - `media_probe` — ffprobe metadata (duration, resolution, codecs, fps).
  - Requires `ffmpeg`/`ffprobe` on PATH. Key resolution: `ZHIZENGZENG_API_KEY` env, then `~/.pi/agent/media-tools.json`. Known gateway limits: OpenAI-format `video_url` does not deliver video; the Files API upload returns 500 — hence inline + transcode.
- Safety gate (`extensions/safety-gate.ts`), model-agnostic bench rails:
  - Blocks `rm -rf` on root/home/cwd, `mkfs`, `dd` to devices, fork bombs, force pushes, `curl|sh` remote-code execution, runtime `pi install`, and executing/sourcing workspace `SKILL.md` files.
  - Backs up existing files to `~/.pi/agent/safety-backups/<date>/` before `write`/`edit` overwrites (first backup of the day per file).
- Vendored memory, bench-slim by default: `memory_read` + lexical `memory_search` only. Set `PI_MEMORY_BENCH=0` to restore write/curator/share tools. For harness runs also set `PI_MEMORY_FINALIZE=0` and `PI_MEMORY_SKILL_DRAFTS=off` to disable shutdown finalization noise.
- Companions installed by bootstrap: `pi-web-access`, `@lebronj/pi-lsp`.
- Web fetch fallback (`pi-web-access`): bootstrap writes `~/.pi/web-search.json` with `fetchRouting.allowRemoteHostedProviders: true` and `providers: [http, firecrawl, jina, tinyfish, search1api]`, so pages that fail plain `http`/Readability (403 / anti-bot / JS-rendered) fall back to `jina` (r.jina.ai). Search routing defaults to `serper` with `jina` fallback. Set `SERPER_API_KEY` / `JINA_API_KEY` in that file for the fallback tiers.
- Reward-only self-evolution loop (`bench/evolve/`): evaluates the harness on a task set for multiple rounds, feeds back only PASS/FAIL/TIMEOUT plus the agent's own traces (never grader output), and evolves `bench/workspace/` (system prompt append, memory card, tool trims, skills) with evidence-backed change manifests falsified by next-round flips. See `bench/evolve/README.md`.
- `/bench` command (`extensions/bench.ts`), the in-pi switch for the loop: `/bench tasks` lists tasks, `/bench run [task ...]` starts a one-off eval in the background, `/bench evolve [N]` starts the self-evolution loop, `/bench` shows status/results, `/bench stop` kills the run. Operator-only: disabled in the eval profile, and bench child processes never register it (`PI_BENCH_CHILD=1`).

Not installed or loaded:

- pet, snake, TPS, prompt URL widget
- autogoal, goal-mode, pi-suite-repair
- team git prompts and skill-creator / PPT / pi-skill dumps
- `pi-subagents`, `pi-mcp-adapter`, `pi-mono-figma`

Do not also list those companions inside this package manifest; duplicates conflict.

## Autogoal (not loaded on this branch; leftover from main)

`/autogoal <task>` starts a bounded autonomous coding run. It persists the objective, auto-continues with loop budgets, checkpoints at high context usage, and can continue in a fresh session when the context window gets tight.

Useful commands:

```bash
/autogoal <task>
/autogoal status
/autogoal pause
/autogoal resume
/autogoal checkpoint optional reason
/autogoal drop
```

Behavior:

- 60% context: prepare and stay concise.
- 75% context: write a structured checkpoint soon.
- 85% context: checkpoint and switch to a new session.
- Completion requires current-state evidence: changed files read after edits and a passing validation command.
- Subagents are optional and budgeted; worker subagents must use worktree isolation.
- Run artifacts are written under `~/.pi/agent/workflow-runs/autogoal-<run-id>/`.

## Update Plan

The `update_plan` tool gives Pi a Codex-style visible execution checklist for non-trivial tasks. It supports `init`, `start`, `done`, `drop`, `rm`, `append`, and `note`, shows active plan progress in the UI, and injects guidance to use it for 3+ step tasks or user-provided checklists.

Useful commands:

```bash
/plan-status
/plan-clear
```

## Default Model Setup

Bootstrap writes the Lenovo DeepSeek provider above. The API key is entered at install time and stays on the user's machine. Do not publish a shared key in this package.

Old team endpoint leftover (main):

```bash
TEAM_PROFILE=legacy bash scripts/bootstrap.legacy.sh
```

## Memory And Versioning

`@jhp/pi-memory` works without qmd for core memory features:

- `memory_write`
- `memory_read`
- `memory_edit`
- `scratchpad`
- `memory_curate`

`memory_search` automatically falls back to local lexical matching without qmd or embeddings. The bootstrap script installs qmd and initializes its collection when Bun is available, but does not run the time-consuming embedding step. Run `qmd embed` only when semantic search is needed. If Bun is missing, install qmd later:

```bash
bun install -g https://github.com/tobi/qmd
qmd collection add ~/.pi/agent/memory --name pi-memory
qmd embed
```

Memory versioning is enabled by default. It snapshots the resolved memory root and resolved disabled skill-draft root into the local evolution repo, commits local changes automatically, and leaves push manual by default. Standalone Pi resolves to `~/.pi/agent/memory` and `~/.pi/agent/skill-drafts`; Multica-connected runs can resolve to `~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>/memory` and `skills/drafts`. `memory_curate` also scans yesterday's daily log into `REVIEW.md` when learning is enabled and the daily file changed since the last scan.

For local multi-agent self-evolution, `@jhp/pi-memory` now supports:

- `PI_MEMORY_DIR`, `PI_SKILL_DRAFTS_DIR`, `PI_AGENT_ROOT`, `MULTICA_WORKSPACE_ID`, `MULTICA_AGENT_ID`, and `MULTICA_WORKSPACES_ROOT` resolvers.
- Agent root initialization with isolated `memory/`, `skills/drafts`, `skills/generated`, `inbox/`, `shared-cache/`, `profile/`, `feedback/`, and `sync_queue/` directories.
- `/memory-review` plus startup and `memory_curate` pending proposal reminders.
- A Local Curator Manager registry/dirty-root API for one local manager to process many agent roots safely.
- Share candidate, downflow receive, sync upload/pull, profile generation, Local Curator Manager tools, and feedback JSONL helpers. Server downflow is per-Agent delivery, not broadcast, and local delivery never overwrites formal memory or auto-enables skills.

The external memory curator service uses a systemd user timer when available, with cron fallback. When the service points at a vendored TypeScript CLI under `node_modules`, the launcher uses Bun or tsx instead of plain Node so Node 22 can run it reliably.

Useful commands:

```bash
/memory-version-status
/memory-version-snapshot optional reason
/memory-version-list
/memory-version-restore <snapshot-id> [memory|skill-drafts|all]
/memory-version-push
```

Memory evolution is local-only by default and does not configure a shared remote. If a user wants backup sync, set `PI_EVOLUTION_REMOTE` to their own private repo before bootstrap/setup, or add a personal remote later with `git -C ~/.pi/agent/evolution remote add origin <url>`. Set `PI_EVOLUTION_AUTO_PUSH=1` only if automatic remote sync is desired.

## Review And Commit Workflows

Use `/review [target] [--fix] [--comment] [--summary]` to inspect current diffs, branch ranges, or PRs with findings first and a verdict last. It is local-only by default: GitHub comments are drafted first and posted only after explicit confirmation.

Use `/commit [message|split|pr|apply]` to inspect current changes, warn about mixed concerns, draft commit messages, suggest split points, or draft PR text. It does not stage, commit, or push unless you explicitly confirm the exact action.

These workflows are prompt-template workflows only. They do not merge read behavior, add tool discovery, rewrite memory/skills, or run as hidden background processes.

## Goal Mode (not loaded on this branch; leftover from main)

Use `/goal <objective>` to keep Pi working on one task until it is verified complete. Goal mode injects hidden task context, enables a `goal` tool for pause/drop/resume/completion, tracks token/time budget usage, and auto-continues between turns instead of stopping at a minimal implementation.

Useful commands:

```bash
/goal <objective>
/goal show
/goal pause
/goal resume
/goal drop
/goal budget <tokens|off>
/goal auto on
/goal auto off
```

## Update

```bash
pi update
```

Only update Pi itself:

```bash
pi update --self
```

Only update installed Pi packages:

```bash
pi update --extensions
```
