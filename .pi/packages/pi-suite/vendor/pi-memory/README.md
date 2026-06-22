# @jhp/pi-memory

Structured, time-aware memory extension for pi. It stores memory as plain Markdown, exposes one set of memory tools to the agent, and includes curator rules for lifecycle maintenance.

## Features

- Plain Markdown storage under resolved memory roots: standalone `~/.pi/agent/memory`, explicit `PI_MEMORY_DIR`, or Multica `~/multica_workspaces/<workspace>/.pi/agents/<agent>/memory`.
- Unified tools for memory write/read/edit/search and scratchpad management.
- Structured `USER.md`, `STATE.md`, and `REVIEW.md` entries with metadata.
- Optional qmd-powered keyword, semantic, and deep search.
- KV cache-stable context injection by default.
- Curator core for exact dedupe, event lifecycle updates, temporary review, quota reset, and audit logs.
- Review-first learning candidates that can become memory promotions or disabled skill drafts after approval, with `/memory-review` pending reminders.
- Local multi-agent self-evolution layout for Multica: scoped memory/skill roots, `sync_queue/`, `inbox/`, `shared-cache/`, `profile/`, and `feedback/`.
- Optional external curator service via systemd user timer or cron so curation can run even when pi is closed.

## Installation

```bash
pi install npm:@jhp/pi-memory
```

Local development:

```bash
pi install ./pi-memory
```

Optional search support requires qmd:

```bash
bun install -g https://github.com/tobi/qmd
qmd collection add ~/.pi/agent/memory --name pi-memory
qmd embed
```

The extension auto-creates the `pi-memory` qmd collection and path contexts on session start when qmd is available.

## File Layout

```text
# Standalone fallback
~/.pi/agent/memory/
~/.pi/agent/skill-drafts/

# Multica-connected scoped root
~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>/
  memory/
    MEMORY.md USER.md STATE.md REVIEW.md SCRATCHPAD.md
    .curator-state.json
    audit/curator.jsonl
    daily/YYYY-MM-DD.md
  skills/
    drafts/<slug>/SKILL.md      # Disabled skill drafts created after approval
    generated/                  # Downflow skill deliveries, not auto-enabled
    enabled/                    # Reserved for explicit enablement
  inbox/memory/ inbox/skills/   # Raw downflow deliveries for this agent only
  shared-cache/memory/ shared-cache/skills/
  profile/user-profile.md agent-profile.md task-profile.md capability-profile.md
  feedback/feedback.jsonl
  sync_queue/memory-candidates.jsonl skill-candidates.jsonl
```

Structured entries are separated by `§` and may start with metadata:

```md
[type:event status:planned date:2026-06-10]
User plans to watch the NBA Finals.
```

Metadata keys currently supported by tools and curator rules:

- `type`: `fact`, `preference`, `event`, `temporary`, `quota`, `review`
- `status`: `planned`, `today`, `past`, `active`, `exhausted`, `archived`, etc.
- `date`: event or temporary memory date, `YYYY-MM-DD`
- `reset`: quota reset date/time
- `month`: quota month, `YYYY-MM`
- `provider`: quota provider
- `used`, `limit`: quota counters
- `ttlDays`: temporary memory TTL hint

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_write` | Write `MEMORY.md`, daily logs, or structured `USER.md` / `STATE.md` / `REVIEW.md` entries |
| `memory_read` | Read one memory target, all memory files, or daily log lists |
| `memory_edit` | Read/add/replace/remove/replace_all/compact structured entries |
| `scratchpad` | Manage checklist items in `SCRATCHPAD.md` |
| `memory_search` | Search all memory files with qmd |
| `memory_curate` | Run curator rules immediately |
| `memory_learning_approve` | Approve one proposed memory or skill promotion by exact id |
| `memory_learning_reject` | Reject or archive one review item by exact id |
| `memory_skill_drafts` | List proposed skill drafts |
| `memory_skill_list` | List current-agent draft, generated, and enabled skills |
| `memory_skill_enable` | Enable a draft/generated skill into `skills/enabled` |
| `memory_skill_disable` | Disable an enabled skill while preserving its source |
| `memory_curator_enable` | Enable the external daily curator service |
| `memory_curator_disable` | Disable the external daily curator service |
| `memory_curator_status` | Show service backend, schedule, and state |
| `memory_sync_upload` / `/memory-sync-upload` | Upload governed candidates, profiles, and feedback when Multica remote config is set |
| `memory_sync_pull` / `/memory-sync-pull` | Pull current-agent deliveries into inbox/cache/generated-skill locations |
| `memory_feedback` | Append shared unit usage feedback to `feedback/feedback.jsonl` |
| `memory_curator_manager_mark_dirty` | Register and mark the current agent root dirty |
| `memory_curator_manager_scan` / `/memory-curator-manager-scan` | Process dirty roots from the singleton manager registry |
| `memory_curator_manager_enable` | Enable the singleton manager service; default checks dirty roots every 6 hours |
| `memory_curator_manager_disable` | Disable the singleton manager service |
| `memory_curator_manager_status` | Show singleton manager service status |
| `/memory-skill` | Slash command for list/enable/disable skill lifecycle actions |
| `/memory-review` | List/show/approve/reject/archive/compact pending memory and skill proposals in the current root |

### memory_write Targets

- `long_term`: append/overwrite `MEMORY.md`
- `daily`: append today's daily log
- `user`: append structured `USER.md` entry
- `state`: append structured `STATE.md` entry
- `review`: append structured `REVIEW.md` entry

For time-sensitive facts, prefer `target="state"` plus metadata:

```json
{
  "target": "state",
  "type": "event",
  "date": "2026-06-10",
  "content": "User plans to watch the NBA Finals."
}
```

## Context Injection

By default, pi-memory injects a stable snapshot into the system prompt. It includes:

1. Open scratchpad items
2. Today's daily log
3. qmd search results, only in `PI_MEMORY_SNAPSHOT=per-turn` mode
4. `USER.md`
5. current `STATE.md` entries, excluding `status:past` and `status:archived`
6. `MEMORY.md`
7. Yesterday's daily log
8. Matched shared-cache memories/generated skills for Multica-scoped roots
9. Explicitly enabled current-agent skills as `<available_skills>` metadata

The stable snapshot refreshes on session start, compaction, long-term or structured writes, and day rollover. Use `memory_read` or `memory_search` for the latest authoritative state.

## Curator

The curator core is included in this package and can be run with `memory_curate` or by the external curator service. Current rules:

- Exact duplicate entries are deduplicated.
- `type:event` entries move from `planned`/`today` to `past` after their `date` passes.
- `type:event status:planned` becomes `status:today` on the event date.
- Expired `type:temporary` entries append a review item to `REVIEW.md` instead of being deleted.
- `type:quota` entries reset to `active` with `used:0` when their month/reset rolls over.
- Every applied patch is written to `audit/curator.jsonl`.

The curator deliberately avoids semantic auto-delete or semantic auto-merge in this version. Those should first become review entries to avoid losing user memory.

## Review-First Learning

Session shutdown may extract conservative learning candidates from the recent conversation text. Candidates are written only to `REVIEW.md`; they are not injected as normal context, not written to long-term memory, and not enabled as skills.

Candidate examples:

```md
[type:review status:candidate id:rev_abc kind:preference confidence:medium seen:2 first_seen:2026-06-10 last_seen:2026-06-12 target_hints:memory]
Signature: User prefers concise direct answers.
Summary: User prefers concise direct answers.
```

```md
[type:review status:candidate id:rev_def kind:skill_candidate confidence:medium seen:3 first_seen:2026-06-10 last_seen:2026-06-12 target_hints:skill]
Signature: fix non erasable TypeScript syntax in pi source
Summary: Replace enum and parameter properties with erasable syntax.
```

When candidates repeat, pi-memory updates the existing candidate instead of appending duplicates. It increments `seen`, updates `last_seen`, preserves higher confidence, and appends compact new evidence.

`memory_curate` can turn stable candidates into proposals:

- `kind:memory_promotion status:proposed` for durable preferences, project facts, or concise lessons.
- `kind:skill_promotion status:proposed` for repeated skill-worthy methods.

Approval is explicit by default:

- `memory_curate` reports pending memory/skill proposal counts and suggests `/memory-review` plus approve/reject tools.
- Pi session start shows one lightweight pending-review hint when proposals exist; disable with `PI_MEMORY_REVIEW_STARTUP_HINT=0`.
- `/memory-review` lists pending proposals and supports `show <id>`, `approve <id>`, `reject <id>`, and `archive <id>` for the current resolved root.
- `memory_learning_approve` on a memory proposal writes `MEMORY.md`, `USER.md`, or `STATE.md` depending on the proposal target.
- `memory_learning_approve` on a skill proposal writes the current resolved skill draft root and marks the proposal approved.
- Skill drafts are disabled. They are not moved into enabled skill directories automatically.
- `memory_skill_enable` explicitly copies a `draft:<slug>` or `generated:<id>` skill into `skills/enabled/<skill-name>/` and writes `memory/audit/skill-lifecycle.jsonl`.
- `memory_skill_disable` removes only the enabled copy; the draft/generated source remains for later review.
- Enabled skills are injected as available-skill metadata so the agent can read the corresponding `SKILL.md` when the task matches.
- `memory_learning_reject` marks a candidate or proposal as `rejected` or `archived` without deleting it.

Old candidates are lifecycle-managed without deletion. Low-confidence candidates can become `archived`; others become `needs_review` first. `REVIEW.md` remains the evidence and audit trail, so approved items are marked rather than removed.

Current learning extraction is text-based: it reads user/assistant conversation messages and asks the active model for structured candidates. It does not yet inspect structured tool-call graphs directly. Curator patch audit remains in `audit/curator.jsonl`; learning approvals are tracked through `REVIEW.md` proposal metadata and status changes.

## Local Multi-Agent Self-Evolution

Resolver priority:

1. `PI_MEMORY_DIR` and `PI_SKILL_DRAFTS_DIR` when explicitly set.
2. `PI_AGENT_ROOT` when set, deriving `memory/` and `skills/drafts/`.
3. `MULTICA_WORKSPACE_ID` + `MULTICA_AGENT_ID`, deriving `~/multica_workspaces/<workspace_id>/.pi/agents/<agent_id>/` (or `MULTICA_WORKSPACES_ROOT`).
4. Standalone fallback `~/.pi/agent/memory` and `~/.pi/agent/skill-drafts`.

`MULTICA_MEMBER_ID` is reserved and does not change v1 paths. Agent A and Agent B therefore get separate memory, skill drafts, generated skills, profiles, feedback, and sync queues.

The package includes local primitives for the full local loop:

- `ensureAgentRoot()` initializes the scoped directory tree.
- `markCurrentRootDirty()` and `scanDirtyRoots()` implement a single Local Curator Manager registry, manager-level locking, stale lock cleanup, and per-root `.curator.lock` processing.
- `generateShareCandidatesFromReview()` and `appendEvolutionCandidate()` write governed share candidates to `sync_queue/` and block secret-like payloads.
- `generateProfiles()` writes conservative local profiles for remote matching input.
- `syncUpload()` / `memory_sync_upload` POST candidates, profiles, and feedback, using a checkpoint to avoid re-uploading prior candidate ids or feedback lines.
- `syncPull()` / `memory_sync_pull` pull only current-agent deliveries and call `receiveDelivery()`.
- `receiveDelivery()` writes server downflow only to `inbox/`, `shared-cache/`, or `skills/generated/`; it never overwrites formal memory or enables skills.
- `appendFeedbackEvent()` / `memory_feedback` writes injected/used/ignored/success/failure/conflict events to `feedback/feedback.jsonl` for connector upload.

Server delivery is per-agent matching, not broadcast. The local runtime must only pull deliveries for the current `MULTICA_AGENT_ID` and still filter before injection.

### Local Curator Manager Service

The manager service is separate from the standalone daily memory curator. It runs `jhp-pi-memory-curator manager-scan` against the registry and only processes roots marked `dirty`; when there are no dirty roots it exits after a cheap registry check.

Default cadence is every six hours using cron syntax `0 */6 * * *`. Enable, inspect, or disable it with:

```bash
jhp-pi-memory-curator manager-enable
jhp-pi-memory-curator manager-status
jhp-pi-memory-curator manager-disable
```

Pi tools provide the same flow: `memory_curator_manager_enable`, `memory_curator_manager_status`, and `memory_curator_manager_disable`. Slash commands `/memory-curator-manager-enable`, `/memory-curator-manager-status`, and `/memory-curator-manager-disable` are also available. Pass `--registry` or the tool `registry` parameter to override the default registry path.

## External Curator Service

`@jhp/pi-memory` includes a CLI and pi tools for an external daily service. The service is independent of the pi process, so curation can still run when pi is closed.

CLI:

```bash
jhp-pi-memory-curator enable --schedule 03:00
jhp-pi-memory-curator status
jhp-pi-memory-curator run-once
jhp-pi-memory-curator disable
```

Pi tools and commands:

- `memory_curator_enable` / `/memory-curator-enable [HH:MM]`
- `memory_curator_disable` / `/memory-curator-disable`
- `memory_curator_status` / `/memory-curator-status`

The controller uses a systemd user timer when available and falls back to cron. State is written to `.curator-service.json` in the memory directory. Removing the package disables future pi tools; run disable before uninstalling if your package manager does not run uninstall lifecycle scripts.

## Configuration

| Variable | Values | Default | Description |
| --- | --- | --- | --- |
| `PI_MEMORY_DIR` | path | resolved fallback | Override memory root |
| `PI_SKILL_DRAFTS_DIR` | path | resolved fallback | Override disabled skill draft root |
| `PI_AGENT_ROOT` | path | derived from Multica env when present | Current local agent root |
| `MULTICA_WORKSPACES_ROOT` | path | `~/multica_workspaces` | Base for derived Multica roots |
| `MULTICA_WORKSPACE_ID` | string | unset | Current Multica workspace id |
| `MULTICA_AGENT_ID` | string | unset | Current Multica agent id |
| `MULTICA_RUN_ID` | string | unset | Current Multica run id for feedback |
| `PI_AGENT_INBOX_DIR` | path | `$PI_AGENT_ROOT/inbox` | Downflow inbox override |
| `PI_AGENT_SHARED_CACHE_DIR` | path | `$PI_AGENT_ROOT/shared-cache` | Shared cache override |
| `PI_AGENT_PROFILE_DIR` | path | `$PI_AGENT_ROOT/profile` | Profile directory override |
| `PI_AGENT_FEEDBACK_DIR` | path | `$PI_AGENT_ROOT/feedback` | Feedback directory override |
| `PI_AGENT_SYNC_QUEUE_DIR` | path | `$PI_AGENT_ROOT/sync_queue` | Upload queue override |
| `PI_MEMORY_MANAGER_SCHEDULE` | cron/systemd schedule | `0 */6 * * *` | Suggested schedule for the Local Curator Manager dirty-root scan service |
| `PI_MEMORY_REVIEW_STARTUP_HINT` | `0`/unset | unset | Set `0` to hide startup pending review hints |
| `PI_MEMORY_SNAPSHOT` | `stable`, `per-turn` | `stable` | Stable context injection or legacy per-turn rebuild |
| `PI_MEMORY_QMD_UPDATE` | `background`, `manual`, `off` | `background` | Control qmd update after writes |
| `PI_MEMORY_NO_SEARCH` | `1` | unset | Disable per-turn search injection |
| `PI_MEMORY_SUMMARIZE_TRANSITIONS` | `1`, `true`, `yes`, `on` | unset | Also summarize lifecycle transitions |
| `PI_MEMORY_LEARNING` | `off`, `review`, `auto-review` | `review` | Control session learning candidate extraction |
| `PI_MEMORY_LEARNING_MIN_CONFIDENCE` | `low`, `medium`, `high` | `medium` | Minimum extractor confidence to keep |
| `PI_MEMORY_SKILL_DRAFTS` | `off`, `review` | `review` | Allow curator to propose disabled skill drafts |
| `PI_MEMORY_AUTO_APPROVE_MEMORY` | `1`, `true`, `yes`, `on` | unset | YOLO mode for approving newly created memory proposals |
| `PI_MEMORY_AUTO_APPROVE_SKILL_DRAFTS` | `1`, `true`, `yes`, `on` | unset | YOLO mode for creating newly proposed disabled skill drafts |

## Development

```bash
npm install --ignore-scripts
npm test
npm run pack:check
```

This package is a pi package. The pi manifest is in `package.json`:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```
