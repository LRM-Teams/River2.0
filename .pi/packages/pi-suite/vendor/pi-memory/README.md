# @jhp/pi-memory

Structured, time-aware memory extension for pi. It stores memory as plain Markdown, exposes one set of memory tools to the agent, and includes curator rules for lifecycle maintenance.

## Features

- Plain Markdown storage under `~/.pi/agent/memory`.
- Unified tools for memory write/read/edit/search and scratchpad management.
- Structured `USER.md`, `STATE.md`, and `REVIEW.md` entries with metadata.
- Optional qmd-powered keyword, semantic, and deep search.
- KV cache-stable context injection by default.
- Curator core for exact dedupe, event lifecycle updates, temporary review, quota reset, and audit logs.
- Review-first learning candidates that can become memory promotions or disabled skill drafts after approval.
- Optional external curator service via systemd user timer or cron so curation can run even when pi is closed.
- Snapshot + git versioning for `memory/` and disabled `skill-drafts/`, with restore support.

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
~/.pi/agent/memory/
  MEMORY.md              # Durable facts, decisions, and preferences
  USER.md                # Structured user profile and stable preferences
  STATE.md               # Current dated state, events, temporary facts, quotas
  REVIEW.md              # Review queue for stale or merge-candidate memories
  SCRATCHPAD.md          # Checklist of open items
  .curator-state.json    # Last curator run state
  audit/curator.jsonl    # Curator audit trail
  daily/YYYY-MM-DD.md    # Daily append-only logs
~/.pi/agent/skill-drafts/
  <slug>/SKILL.md        # Disabled skill drafts created after approval
~/.pi/agent/evolution/
  memory/                # Current memory mirror
  skill-drafts/          # Current skill draft mirror
  snapshots/<id>/        # Point-in-time backup with manifest.json
  manifests/<id>.json    # Snapshot manifest index
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
| `memory_curator_enable` | Enable the external daily curator service |
| `memory_curator_disable` | Disable the external daily curator service |
| `memory_curator_status` | Show service backend, schedule, and state |
| `memory_version_status` | Show local evolution git repo status |
| `memory_version_snapshot` | Manually snapshot memory and skill drafts |
| `memory_version_list` | List recent snapshots |
| `memory_version_restore` | Restore `memory`, `skill-drafts`, or `all` from a snapshot id |
| `memory_version_push` | Manually push the evolution repo to GitHub |

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

- `memory_learning_approve` on a memory proposal writes `MEMORY.md`, `USER.md`, or `STATE.md` depending on the proposal target.
- `memory_learning_approve` on a skill proposal writes `~/.pi/agent/skill-drafts/<slug>/SKILL.md` and marks the proposal approved.
- Skill drafts are disabled. They are not moved into enabled skill directories automatically.
- `memory_learning_reject` marks a candidate or proposal as `rejected` or `archived` without deleting it.

Old candidates are lifecycle-managed without deletion. Low-confidence candidates can become `archived`; others become `needs_review` first. `REVIEW.md` remains the evidence and audit trail, so approved items are marked rather than removed.

Current learning extraction is text-based: it reads user/assistant conversation messages and asks the active model for structured candidates. It does not yet inspect structured tool-call graphs directly. Curator patch audit remains in `audit/curator.jsonl`; learning approvals are tracked through `REVIEW.md` proposal metadata and status changes.

## Memory Versioning

Pi-memory mirrors the authoritative runtime directories into a local evolution repo and stores point-in-time snapshots before important changes:

```text
~/.pi/agent/evolution/
  memory/
  skill-drafts/
  snapshots/<snapshot-id>/
    memory/
    skill-drafts/
    manifest.json
  manifests/<snapshot-id>.json
```

Authoritative runtime data remains `~/.pi/agent/memory` and `~/.pi/agent/skill-drafts`; `~/.pi/agent/evolution` is a versioned mirror and backup repo.

Automatic hooks snapshot before and sync/commit after `memory_write`, mutating `memory_edit`, mutating `scratchpad`, `memory_curate`, learning approve/reject, session summary/handoff writes, compaction handoffs, and external `jhp-pi-memory-curator run-once`. Read-only operations do not snapshot.

Tools and slash commands:

- `memory_version_status` / `/memory-version-status`
- `memory_version_snapshot` / `/memory-version-snapshot [reason]`
- `memory_version_list` / `/memory-version-list`
- `memory_version_restore` / `/memory-version-restore <snapshot-id> [memory|skill-drafts|all]`
- `memory_version_push` / `/memory-version-push`

Restore always creates a pre-restore snapshot first, then restores the selected target, syncs the mirror, and commits `memory: restore snapshot <id>`.

Default remote is `https://github.com/LRM-Teams/pi-evolution.git`. Auto commit is on; auto push is off unless `PI_EVOLUTION_AUTO_PUSH=1` is set. The repo should be private because memory contents are committed in plaintext, including any secret accidentally written to memory.

## External Curator Service

`@jhp/pi-memory` includes a CLI and pi tools for an external daily service. The service is independent of the pi process, so curation can still run when pi is closed.

CLI:

```bash
jhp-pi-memory-curator enable --schedule 03:00
jhp-pi-memory-curator status
jhp-pi-memory-curator run-once
jhp-pi-memory-curator snapshot --reason "manual backup"
jhp-pi-memory-curator push
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
| `PI_MEMORY_DIR` | path | `~/.pi/agent/memory` | Override storage directory |
| `PI_MEMORY_SNAPSHOT` | `stable`, `per-turn` | `stable` | Stable context injection or legacy per-turn rebuild |
| `PI_MEMORY_QMD_UPDATE` | `background`, `manual`, `off` | `background` | Control qmd update after writes |
| `PI_MEMORY_NO_SEARCH` | `1` | unset | Disable per-turn search injection |
| `PI_MEMORY_SUMMARIZE_TRANSITIONS` | `1`, `true`, `yes`, `on` | unset | Also summarize lifecycle transitions |
| `PI_MEMORY_LEARNING` | `off`, `review`, `auto-review` | `review` | Control session learning candidate extraction |
| `PI_MEMORY_LEARNING_MIN_CONFIDENCE` | `low`, `medium`, `high` | `medium` | Minimum extractor confidence to keep |
| `PI_MEMORY_SKILL_DRAFTS` | `off`, `review` | `review` | Allow curator to propose disabled skill drafts |
| `PI_MEMORY_AUTO_APPROVE_MEMORY` | `1`, `true`, `yes`, `on` | unset | YOLO mode for approving newly created memory proposals |
| `PI_MEMORY_AUTO_APPROVE_SKILL_DRAFTS` | `1`, `true`, `yes`, `on` | unset | YOLO mode for creating newly proposed disabled skill drafts |
| `PI_EVOLUTION_ENABLED` | `0`, `1`, `true`, `false` | `1` | Enable snapshot + git versioning |
| `PI_EVOLUTION_DIR` | path | `~/.pi/agent/evolution` | Local evolution repo directory |
| `PI_EVOLUTION_REMOTE` | URL | `https://github.com/LRM-Teams/pi-evolution.git` | Git remote for manual/optional push |
| `PI_EVOLUTION_BRANCH` | branch | `main` | Local branch used for init/clone |
| `PI_EVOLUTION_AUTO_COMMIT` | `0`, `1`, `true`, `false` | `1` | Commit sync/snapshot changes automatically |
| `PI_EVOLUTION_AUTO_PUSH` | `0`, `1`, `true`, `false` | `0` | Push after commits automatically |

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
