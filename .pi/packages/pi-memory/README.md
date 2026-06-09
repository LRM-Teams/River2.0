# @jhp/pi-memory

Structured, time-aware memory extension for pi. It stores memory as plain Markdown, exposes one set of memory tools to the agent, and includes curator rules for lifecycle maintenance.

## Features

- Plain Markdown storage under `~/.pi/agent/memory`.
- Unified tools for memory write/read/edit/search and scratchpad management.
- Structured `USER.md`, `STATE.md`, and `REVIEW.md` entries with metadata.
- Optional qmd-powered keyword, semantic, and deep search.
- KV cache-stable context injection by default.
- Curator core for exact dedupe, event lifecycle updates, temporary review, quota reset, and audit logs.
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
~/.pi/agent/memory/
  MEMORY.md              # Durable facts, decisions, and preferences
  USER.md                # Structured user profile and stable preferences
  STATE.md               # Current dated state, events, temporary facts, quotas
  REVIEW.md              # Review queue for stale or merge-candidate memories
  SCRATCHPAD.md          # Checklist of open items
  .curator-state.json    # Last curator run state
  audit/curator.jsonl    # Curator audit trail
  daily/YYYY-MM-DD.md    # Daily append-only logs
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
| `memory_curator_enable` | Enable the external daily curator service |
| `memory_curator_disable` | Disable the external daily curator service |
| `memory_curator_status` | Show service backend, schedule, and state |

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
| `PI_MEMORY_DIR` | path | `~/.pi/agent/memory` | Override storage directory |
| `PI_MEMORY_SNAPSHOT` | `stable`, `per-turn` | `stable` | Stable context injection or legacy per-turn rebuild |
| `PI_MEMORY_QMD_UPDATE` | `background`, `manual`, `off` | `background` | Control qmd update after writes |
| `PI_MEMORY_NO_SEARCH` | `1` | unset | Disable per-turn search injection |
| `PI_MEMORY_SUMMARIZE_TRANSITIONS` | `1`, `true`, `yes`, `on` | unset | Also summarize lifecycle transitions |

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
