# @lebronj/pi-suite

JHP's Pi extension suite for team coding workflows.

## Install

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install npm:@lebronj/pi-suite
pi install npm:pi-mcp-adapter
pi install npm:pi-subagents
pi install npm:pi-web-access
```

Or use the bootstrap script to install Pi, configure the team OpenAI-compatible endpoint, install this suite, and set up Bun + qmd for memory search:

```bash
curl -fsSL https://registry.npmjs.org/@lebronj/pi-suite/-/pi-suite-0.1.23.tgz | tar -xzO package/scripts/bootstrap.sh | bash
```

## What Is Included

- Local extensions: autogoal, goal mode, update_plan, pet, prompt URL widget, snake, TPS notifications.
- Prompts: changelog audit, issue analysis, PR review, review workflow, commit workflow, wrap workflow.
- Skills: provider checklist, skill-creation workflow, Pi capability reference, image-to-editable-PPT workflow.
- Vendored package: `@jhp/pi-memory`, including qmd search, external curator service, memory/skill-draft versioning, scoped Multica agent roots, review reminders, and local memory/skill self-evolution queues.

Install the companion packages above with the suite so MCP, subagent, and web tools register from their own package manifests. The bootstrap script installs the same companion packages automatically.

Do not add those companion packages inside the `@lebronj/pi-suite` manifest at the same time; loading them both from the suite manifest and as standalone Pi packages creates duplicate tool/flag registration conflicts.

Existing users can run `pi update --extensions`; if Pi reports missing suite companion packages on startup, run `/pi-suite-repair` and it will install or refresh the currently required companion package set, then reload resources.

Figma is not installed or loaded by default. Enable it only when needed:

```bash
pi install npm:pi-mono-figma
# then run /reload or restart pi
```

Disable Figma later with:

```bash
pi remove npm:pi-mono-figma
# then run /reload or restart pi
```

Debug-only extensions are intentionally excluded:

- `dump-system-prompt.ts`
- `zz-full-session-log.ts`
- `agentmemory`

## Autogoal

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

## Team Model Setup

The bootstrap script can be run with `curl | bash`: it reads the API key from the terminal instead of stdin. It asks for an API key and writes:

- Provider: OpenAI-compatible `openai`
- Base URL: `https://claude-code.club/openai/v1`
- Default model: `gpt-5.5`

The API key is written to `~/.pi/agent/models.json` on the user's machine. Do not publish a shared key in this package.

## Memory And Versioning

`@jhp/pi-memory` works without qmd for core memory features:

- `memory_write`
- `memory_read`
- `memory_edit`
- `scratchpad`
- `memory_curate`

`memory_search` needs qmd. The bootstrap script installs and initializes qmd when Bun is available. If Bun is missing, install qmd later:

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

## Goal Mode

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
