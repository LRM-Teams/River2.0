---
name: pi-skill
description: Reference for this pi agent's installed capabilities, tools, memory system, skills, subagents, web/code search, MCP, and code-intelligence workflows. Use when asked what pi can do, how to use current capabilities, or when changing pi features so this skill stays updated.
---

# Pi Skill

This skill is the local capability index for this pi setup. Use it to answer "what can you do?", choose the right workflow, and keep user-facing capability docs synchronized when features change.

## Maintenance Rule

When adding, removing, renaming, or materially changing any pi capability in this workspace, update this skill in the same change. This includes tools, packages, extensions, memory behavior, skills, subagents, MCP servers, web/search integrations, code-intelligence workflows, commands, prompt templates, and bootstrap behavior.

## Core Coding Tools

- `read`: read text files and images; use this instead of `cat` for file inspection.
- `bash`: run shell commands; prefer `rg`/`rg --files` for search.
- `edit`: precise exact-text replacements in one file.
- `write`: create or overwrite files.
- `goal`: inspect, resume/drop, or complete an active goal-mode objective when goal mode is running.
- `autogoal`: inspect, checkpoint, pause/resume/drop, block, or complete an active bounded autogoal run when `/autogoal` is running.
- `lsp_diagnostics` / `lsp_navigation`: code-intelligence path for diagnostics, definitions, references, hover, symbols, call hierarchy, rename, and workspace diagnostics when pi-lens/LSP tools are installed.
- `ast_grep_search` / `ast_grep_replace` / `ast_dump`: AST-aware code search and replacement when pi-lens tools are installed; prefer over raw text search for structural code patterns.
- `lens_diagnostics`: inspect pi-lens warnings/errors for files touched this session when available.

## Memory And Self-Evolution

Installed memory capability comes from `@jhp/pi-memory`, vendored inside `@lebronj/pi-suite` and also usable as a standalone pi package.

Memory files live under the resolved memory root. Standalone fallback is `~/.pi/agent/memory`; Multica-connected runs can resolve to `~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>/memory` with skill drafts under that agent's `skills/drafts`.

Memory files include:

- `MEMORY.md`: durable facts, decisions, and preferences.
- `USER.md`: structured user profile and stable preferences.
- `STATE.md`: current dated state, events, temporary facts, and quotas.
- `REVIEW.md`: review queue for stale memories, learning candidates, and promotion proposals.
- `SCRATCHPAD.md`: checklist for open items.
- `daily/YYYY-MM-DD.md`: daily append-only logs and session handoffs.
- `.curator-state.json`: last curator run state.
- `.curator-service.json`: external curator service state.
- `audit/curator.jsonl`: curator audit trail.
- Resolved skill draft root `<slug>/SKILL.md`: disabled skill drafts created after explicit approval; skill directories may include supporting files alongside `SKILL.md`.
- Multica agent roots also contain `inbox/`, `shared-cache/`, `skills/generated/`, `profile/`, `feedback/feedback.jsonl`, and `sync_queue/`.
- Skill share candidates are runnable bundles: `sync_queue/skill-candidates.jsonl` is the queue/manifest, while `sync_queue/skill-candidates/<local_unit_id>/` contains `SKILL.md` plus supporting files.

Memory tools:

- `memory_write`: write long-term, daily, user, state, or review memory. Use `target="state"` with metadata for time-sensitive entries.
- `memory_read`: read long-term, scratchpad, daily, list, user, state, review, or all memory.
- `memory_edit`: read/add/replace/remove/replace_all/compact structured entries in `MEMORY.md`, `USER.md`, `STATE.md`, and `REVIEW.md`.
- `scratchpad`: add/done/undo/clear/list checklist items.
- `memory_search`: qmd-backed keyword, semantic, or deep search across memory files.
- `memory_curate`: manually run curator lifecycle rules and scan yesterday's daily log into `REVIEW.md` when learning is enabled; output includes pending proposal counts.
- `memory_learning_approve`: approve a proposed memory promotion or disabled skill draft by exact id.
- `memory_learning_reject`: reject or archive a review candidate/proposal without deleting it.
- `memory_skill_drafts`: list proposed skill drafts.
- `memory_skill_list`: list current-agent draft, generated, and enabled memory-managed skills.
- `memory_skill_enable`: explicitly enable a `draft:<slug>` or `generated:<id>` skill by copying the full skill directory into `skills/enabled/<skill-name>/` and auditing the action.
- `memory_skill_disable`: remove an enabled skill copy while preserving its draft/generated source.
- `/memory-skill`: slash command to list/enable/disable current-agent memory-managed skills.
- `/memory-review`: slash command to list/show/approve/reject/archive pending memory and skill proposals in the current resolved root.
- `memory_curator_enable`: enable the external daily curator service using systemd user timer or cron fallback.
- `memory_curator_disable`: disable and uninstall the external daily curator service.
- `memory_curator_status`: show service backend, schedule, and state.
- `memory_version_status`: show local evolution repo status, remote, branch, dirty state, last commit, and auto-push setting.
- `memory_version_snapshot`: manually snapshot `memory/` and `skill-drafts/`, sync mirrors, and commit.
- `memory_version_list`: list recent snapshots.
- `memory_version_restore`: restore `memory`, `skill-drafts`, or `all` from a snapshot id after creating a pre-restore backup.
- `memory_version_push`: manually push the local evolution repo to GitHub.
- `memory_sync_upload` / `/memory-sync-upload`: upload governed candidates, profiles, and feedback to Multica when remote config is set.
- `memory_sync_pull` / `/memory-sync-pull`: pull only current-agent deliveries into local inbox/cache/generated-skill directories.
- `memory_feedback`: append injected/used/ignored/success/failure/conflict feedback for a shared unit.
- `memory_curator_manager_mark_dirty` and `memory_curator_manager_scan` / `/memory-curator-manager-scan`: register dirty roots and process them through the singleton Local Curator Manager.
- `memory_curator_manager_enable`, `memory_curator_manager_status`, `memory_curator_manager_disable` and `/memory-curator-manager-*` commands: manage the singleton manager service; default schedule is every 6 hours and it only processes dirty roots.

Structured metadata example:

```md
[type:event status:planned date:2026-06-10]
User plans to watch the NBA Finals.
```

Curator and learning behavior:

- Exact duplicate entries are deduplicated.
- Event status transitions: `planned -> today -> past` based on `date`.
- Expired temporary memories go to `REVIEW.md`, not automatic deletion.
- Quotas reset when `month` or `reset` rolls over.
- Mutations are audited to `audit/curator.jsonl`.
- Session shutdown may extract conservative learning candidates into `REVIEW.md`; they are not injected as normal memory and are not auto-enabled.
- `memory_curate` scans yesterday's daily log once per content hash into review candidates, then curator lifecycle and proposal rules process those candidates.
- Repeated candidates can become proposed memory promotions or proposed disabled skill drafts after `memory_curate`.
- Approval is explicit by default: memory proposals write to memory stores; skill proposals write disabled drafts under the resolved skill draft root.
- Draft and generated skills stay disabled until `memory_skill_enable` copies their full directories into `skills/enabled`; enabled skills are injected as `<available_skills>` metadata for the current agent.
- Pi session start can show one pending-review hint; disable with `PI_MEMORY_REVIEW_STARTUP_HINT=0`.
- Local multi-agent self-evolution supports one Local Curator Manager registry/dirty-root API for many agent roots, plus a manager service that runs `manager-scan` every 6 hours and exits quickly when no root is dirty.
- The local loop also covers share candidate queue, profile generation, sync upload/pull, downflow receive cache, generated skills, enabled skill lifecycle, and feedback JSONL helpers.
- Skill upload/downflow follows Multica's runnable bundle shape: `content` is `SKILL.md`, `files` are supporting files, and `content_hash` covers both.
- Server downflow is per-Agent delivery, not broadcast; local receive writes only `inbox/`, `shared-cache/`, or `skills/generated/` and never overwrites formal memory or auto-enables skills.
- The curator avoids semantic auto-delete/merge; ambiguous learning stays in review first.

Memory versioning:

- Runtime memory remains authoritative at the resolved memory root; disabled skill drafts remain authoritative at the resolved skill draft root.
- Versioning mirror and snapshots live at `~/.pi/agent/evolution` by default.
- No remote is configured by default; memory evolution stays local per user/machine unless the user adds a personal private remote.
- Automatic local snapshot + commit is enabled by default; automatic push is disabled unless `PI_EVOLUTION_AUTO_PUSH=1`.
- Snapshots use a sliding window: keep the latest 100 by default, and delete the oldest snapshot directory and manifest when a new snapshot exceeds the limit.
- Snapshots run before mutating memory tools, curator runs, learning approve/reject, session summaries/handoffs, compact handoffs, restore, and external curator `run-once`.
- Slash commands: `/memory-version-status`, `/memory-version-snapshot [reason]`, `/memory-version-list`, `/memory-version-restore <snapshot-id> [memory|skill-drafts|all]`, `/memory-version-push`.
- Restore always writes a pre-restore snapshot first, then restores selected files and commits the restored state.

External curator service:

- This is the main self-evolution maintenance loop: it can run daily outside the pi process, even when pi is closed.
- It uses a systemd user timer when available, with cron fallback.
- For vendored TypeScript CLI paths under `node_modules`, the service launcher uses Bun or tsx instead of plain Node so Node 22 does not fail on TypeScript type stripping.
- On `session_start` and after `/reload`, pi-memory checks service status. If the service is disabled and UI is available, it shows a startup hint with enable/status/disable commands.
- Enable with `/memory-curator-enable 03:00` or ask the agent to call `memory_curator_enable`.
- Inspect with `/memory-curator-status` or `memory_curator_status`.
- Disable with `/memory-curator-disable` or `memory_curator_disable`.
- CLI equivalent: `jhp-pi-memory-curator enable|disable|status|run-once` when the binary is linked by the package manager.
- Disable startup hints with `PI_MEMORY_CURATOR_STARTUP_HINT=0` if a user does not want reminders.
- Before uninstalling `@jhp/pi-memory`, run `memory_curator_disable` or `jhp-pi-memory-curator disable` so any systemd timer or cron entry is removed.

QMD search:

- Core memory works without qmd.
- `memory_search` requires qmd for keyword, semantic, and deep search.
- Bootstrap attempts to install Bun + qmd, adds `~/.pi/agent/memory` as the `pi-memory` collection, and runs `qmd embed`.
- After writes, qmd updates run in the background by default; use `PI_MEMORY_QMD_UPDATE=manual` or `off` to change that.

Useful memory environment variables:

- `PI_MEMORY_DIR`: override memory storage directory.
- `PI_SKILL_DRAFTS_DIR`: override disabled skill draft root.
- `PI_AGENT_ROOT`: current local agent root; derives memory, skill drafts, inbox, shared cache, profile, feedback, and sync queue.
- `MULTICA_WORKSPACE_ID`, `MULTICA_AGENT_ID`, `MULTICA_WORKSPACES_ROOT`, `MULTICA_RUN_ID`: Multica scoped root and feedback context.
- `PI_AGENT_INBOX_DIR`, `PI_AGENT_SHARED_CACHE_DIR`, `PI_AGENT_PROFILE_DIR`, `PI_AGENT_FEEDBACK_DIR`, `PI_AGENT_SYNC_QUEUE_DIR`: override agent subdirectories.
- `PI_MEMORY_SNAPSHOT`: `stable` or `per-turn` context injection mode.
- `PI_MEMORY_QMD_UPDATE`: `background`, `manual`, or `off`.
- `PI_MEMORY_NO_SEARCH=1`: disable per-turn search injection.
- `PI_MEMORY_SUMMARIZE_TRANSITIONS=1`: also summarize lifecycle transitions such as `/reload`.
- `PI_MEMORY_LEARNING`: `off`, `review`, or `auto-review`.
- `PI_MEMORY_SKILL_DRAFTS`: `off` or `review`.
- `PI_MEMORY_AUTO_APPROVE_MEMORY=1`: automatically approve newly created memory proposals.
- `PI_MEMORY_AUTO_APPROVE_SKILL_DRAFTS=1`: automatically create newly proposed disabled skill drafts.
- `PI_MEMORY_CURATOR_STARTUP_HINT=0`: hide the disabled-curator startup hint.
- `PI_MEMORY_REVIEW_STARTUP_HINT=0`: hide pending review proposal startup hints.
- `PI_MEMORY_REMOTE_URL` and `PI_MEMORY_REMOTE_TOKEN`: enable Multica candidate/profile/feedback upload and current-agent delivery pull.
- `PI_EVOLUTION_ENABLED=0`: disable snapshot + git versioning.
- `PI_EVOLUTION_DIR`: override evolution repo directory; default `~/.pi/agent/evolution`.
- `PI_EVOLUTION_REMOTE`: optional personal private Git remote; unset by default.
- `PI_EVOLUTION_BRANCH`: override branch; default `main`.
- `PI_EVOLUTION_AUTO_COMMIT=0`: disable automatic local commits.
- `PI_EVOLUTION_AUTO_PUSH=1`: push automatically after commits.
- `PI_EVOLUTION_MAX_SNAPSHOTS`: maximum local snapshots to keep; default `100`.

## Web And Research

- `web_search`: broad web research. Prefer `queries` with 2-4 varied angles for comprehensive research.
- `fetch_content`: fetch readable content from URLs, GitHub repos, YouTube transcripts/video frames, and local videos. For video questions, pass the user's exact question as `prompt`.
- `get_search_content`: retrieve full content saved by `web_search` or `fetch_content`.
- `code_search`: search programming examples, docs, APIs, GitHub, and Stack Overflow; use for library/API/debugging questions before implementation.
- `librarian` skill: use for evidence-backed open-source library internals with exact GitHub source citations when installed.

## Subagents

Use the `pi-subagents` skill and `subagent` tool for delegation when installed.

Typical uses:

- Advisory review of plans or diffs.
- Parallel investigation across multiple files or hypotheses.
- Implementation handoff with structured acceptance criteria.
- Goal-style loops with verification evidence.

Rules:

- Call `subagent` with `action: "list"` before executing agents.
- Use acceptance contracts for broad implementation handoffs.
- Keep one parent agent in control; subagents contribute context, review, or isolated execution.

## MCP

Use `mcp` to discover and call Model Context Protocol servers/tools when `pi-mcp-adapter` is installed.

Common flow:

```text
mcp({})                         # status
mcp({ server: "name" })         # list tools
mcp({ search: "query" })        # find tools
mcp({ describe: "tool_name" })  # inspect schema
mcp({ tool: "tool_name", args: "{}" })
```

Do not route built-in pi tools through MCP; call them directly.

## Autogoal

Autogoal is provided by `autogoal.ts`.

- Start with `/autogoal <task>`.
- It persists the objective, injects hidden loop context, enables the `autogoal` tool, and auto-continues until verified complete, paused, dropped, blocked, or interrupted.
- It uses bounded loop defaults: 12 autonomous turns per session, 2 no-progress turns, 3 repeated repair attempts, and 4 subagent jobs per run.
- Context thresholds are 60% prepare, 75% checkpoint, and 85% checkpoint plus automatic new-session continuation.
- Completion is gated by current-state evidence: changed files must be read after edits and a relevant validation command must pass before `autogoal({ op: "complete" })` succeeds.
- Subagents are optional; scout/reviewer/verifier are allowed when useful, while worker subagents must use isolated worktrees.
- Run artifacts are audit-only and live under `~/.pi/agent/workflow-runs/autogoal-<run-id>/`; checkpoints also live under `~/.pi/agent/autogoal/checkpoints/`.
- Useful commands: `/autogoal status`, `/autogoal pause`, `/autogoal resume`, `/autogoal checkpoint`, `/autogoal drop`, `/autogoal auto on`, `/autogoal auto off`.

## Goal Mode

Goal mode is provided by `goal-mode.ts`.

- Start with `/goal <objective>`.
- It injects hidden goal context, enables the `goal` tool, and auto-continues until the objective is complete, paused, dropped, budget-limited, or interrupted.
- It tracks assistant token usage and elapsed time, supports `/goal budget <tokens|off>`, and treats budget exhaustion as not completion.
- The agent must verify current files/checks before calling `goal({ op: "complete" })`.
- Useful commands: `/goal show`, `/goal pause`, `/goal resume`, `/goal drop`, `/goal budget <tokens|off>`, `/goal auto on`, `/goal auto off`.

## Update Plan

`update-plan.ts` provides a lightweight Codex-style execution checklist without changing Pi core.

- Tool: `update_plan`.
- Use it for non-trivial tasks with 3+ distinct steps, user-provided checklists, or explicit plan/progress tracking requests.
- Operations: `list`, `init`, `start`, `done`, `drop`, `rm`, `append`, and `note`.
- It keeps phased task state in session history, auto-promotes the next pending task to `in_progress`, and shows widget/footer progress when active.
- Commands: `/plan-status` shows the current plan; `/plan-clear` clears it.

## Pet Companion

The pet extension provides a small terminal companion and durable profile.

- Command: `/pet`.
- Subcommands include `on`, `off`, `cat`, `dog`, `fox`, `bot`, `name`, `mood`, `checkin`, `feed`, `bag`, `equip`, `unequip`, `position`, `reset`, and `ask`.
- `/pet ask <question>` answers from current context without saving the answer into the main session.
- Item drops can happen from tool usage, memory events, and daily check-ins, with pity counters.
- Pet profile/inventory is mirrored at `~/.pi/agent/pet-profile.json` so equipment survives `/new` and future sessions.

## UI And Utility Extensions

- `update-plan.ts`: registers `update_plan`, `/plan-status`, and `/plan-clear` for visible per-session execution planning.
- `prompt-url-widget.ts`: detects PR/issue prompt templates, fetches GitHub metadata with `gh`, shows a widget, and names the session when possible.
- `snake.ts`: `/snake` opens a TUI snake game; `Esc` pauses/saves, `q` quits, arrows/WASD move.
- `tps.ts`: after each assistant run, shows tokens-per-second and token usage details.
- `pi-suite-repair.ts`: registers `/pi-suite-repair` and startup reminders for missing companion Pi packages declared by the suite.
- `memory-curator.ts`: deprecated compatibility notice only; external curation is managed by pi-memory service tools.

## Skills

Suite skills currently include:

- `add-llm-provider`: checklist for adding providers to `packages/ai`.
- `image-to-editable-ppt-slide`: rebuild reference images as editable PowerPoint slides.
- `pi-skill`: this capability index.

Optional package-provided skills can include:

- `figma`: Figma REST/API design exploration and design-to-code workflows from `pi-mono-figma`; not installed or loaded by default, enabled with `pi install npm:pi-mono-figma`.
- `librarian`: library internals research with source citations.
- `pi-subagents`: subagent delegation workflows.
- `ast-grep`: AST-aware code search/replace guidance.
- `lsp-navigation`: LSP diagnostics and navigation guidance.
- `write-ast-grep-rule`: author pi-lens ast-grep rules.
- `write-tree-sitter-rule`: author pi-lens tree-sitter rules.

## Prompt Templates

Suite prompt templates currently include:

- `/cl`: changelog audit workflow.
- `/is`: issue analysis workflow.
- `/pr`: GitHub PR review workflow.
- `/wr`: wrap-up workflow with final comment guidance.

## Package And Bootstrap Notes

Global user package configuration is in `~/.pi/agent/settings.json`; project package configuration is in `.pi/settings.json` and `.pi/npm/package.json`.

Current suite package:

- `@lebronj/pi-suite`: bundles local extensions, prompts, suite skills, and vendored `@jhp/pi-memory`. The bootstrap script installs `pi-mcp-adapter`, `pi-subagents`, and `pi-web-access` as standalone companion Pi packages. It does not install or load `pi-mono-figma` by default.

Common project packages:

- `@jhp/pi-memory`
- `pi-mono-figma` (install and enable only on demand with `pi install npm:pi-mono-figma`)
- `pi-web-access`
- `pi-mcp-adapter`
- `pi-subagents`
- `pi-lens`

Bootstrap behavior:

- Installs global `@earendil-works/pi-coding-agent`.
- Writes the team OpenAI-compatible provider to `~/.pi/agent/models.json`.
- Sets default provider/model in `~/.pi/agent/settings.json`.
- Runs `pi install npm:@lebronj/pi-suite` by default, then installs companion packages with `pi install npm:pi-mcp-adapter`, `pi install npm:pi-subagents`, and `pi install npm:pi-web-access`; this does not install or load `pi-mono-figma`.
- Prints follow-up instructions for enabling Figma later with `pi install npm:pi-mono-figma` and disabling it with `pi remove npm:pi-mono-figma`.
- Creates `~/.pi/agent/memory` and links it into the workspace `.pi/memory` when safe.
- Optionally initializes the local `~/.pi/agent/evolution` repo for memory/skill-draft snapshots; it never writes tokens or enables auto-push.
- Links suite skills into the workspace `.pi/skills` when safe.
- Installs Bun + qmd when possible and initializes the `pi-memory` qmd collection.
- Does not auto-enable the external memory curator service; the startup hint explains how to enable it.

## Recommended Workflows

- For code changes: inspect files, edit deliberately, run targeted tests, then run the repo's relevant check command.
- For memory changes: use `memory_write` for new facts and `memory_edit` for updates/removals.
- For time-sensitive memory: write structured `STATE.md` entries with `type`, `status`, and date/reset metadata.
- For self-evolution upkeep: keep the external curator service enabled unless the user opts out, and review `REVIEW.md` proposals before approving memory or skill promotions.
- For web facts or current events: use `web_search`; for page/video details, use `fetch_content`.
- For library internals: use `librarian` or `code_search` with source-backed evidence.
- For broad or risky tasks: use subagents for investigation/review, then integrate deliberately.
