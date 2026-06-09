# Memory Curator Integration Spec

## Current Direction

The standalone `pi-memory-curator` package plan has been retired. Curator logic and external service management now live inside `@jhp/pi-memory`.

The project-local `.pi/extensions/memory-curator.ts` is deprecated and only displays a compatibility notice. It should not run timers, register memory tools, or own curator behavior.

## Implemented Shape

```text
.pi/packages/pi-memory/
  index.ts                         # pi extension: memory tools, qmd search, context injection, service tools
  src/
    cli.ts                         # jhp-pi-memory-curator CLI
    index.ts                       # public curator/service exports
    service-controller.ts          # systemd user timer / cron controller
    curator-core/
      audit.ts
      curate.ts
      metadata.ts
      patch.ts
      policy.ts
    curator-store/
      file-store.ts
      types.ts
  test/
    curate.test.ts
    metadata.test.ts

.pi/extensions/memory-curator.ts   # deprecated compatibility notice only
```

## Runtime Split

`@jhp/pi-memory` is the single user/agent-facing memory package:

- `memory_write`
- `memory_read`
- `memory_edit`
- `memory_search`
- `scratchpad`
- `memory_curate`
- `memory_curator_enable`
- `memory_curator_disable`
- `memory_curator_status`
- memory context injection
- qmd setup/update helpers
- curator core and file store
- external service controller

## External Service

The service is designed to run independently of pi. Closing pi does not stop scheduled curation.

CLI:

```bash
jhp-pi-memory-curator run-once --memory-dir ~/.pi/agent/memory --reason manual
jhp-pi-memory-curator enable --memory-dir ~/.pi/agent/memory --schedule 03:00
jhp-pi-memory-curator status --memory-dir ~/.pi/agent/memory
jhp-pi-memory-curator disable --memory-dir ~/.pi/agent/memory
```

Controller behavior:

- Prefer systemd user timers on Linux when `systemctl --user` is available.
- Fall back to cron when systemd user timers are unavailable.
- Store service state in `~/.pi/agent/memory/.curator-service.json`.
- Keep enable/disable idempotent.
- Use user-level services only; do not require sudo.

Pi-facing controls:

- `memory_curator_enable` / `/memory-curator-enable [HH:MM]`
- `memory_curator_disable` / `/memory-curator-disable`
- `memory_curator_status` / `/memory-curator-status`

## Memory Store

The unified memory root remains:

```text
~/.pi/agent/memory/
  MEMORY.md
  USER.md
  STATE.md
  REVIEW.md
  SCRATCHPAD.md
  daily/YYYY-MM-DD.md
  .curator-state.json
  .curator-service.json
  audit/curator.jsonl
```

Structured entries are separated by:

```text
\n§\n
```

Structured metadata uses the first line:

```md
[type:event status:planned date:2026-06-10]
User plans to watch the NBA Finals.
```

## Curator Rules

The current deterministic curator rules are conservative:

- Exact duplicate entries are deduplicated.
- `type:event status:planned` becomes `status:today` on its `date`.
- `type:event status:planned|today` becomes `status:past` after its `date`, and the body is rewritten to say completion is unknown.
- Expired `type:temporary` entries append review items to `REVIEW.md`; they are not deleted automatically.
- `type:quota` entries reset to `status:active`, `used:0`, and the current month when the month/reset rolls over.
- Every applied mutation writes a JSONL audit entry.

## Deliberate Non-Goals For This Version

- No semantic auto-delete.
- No semantic auto-merge.
- No LLM-written memory patches.
- No separate `pi-memory-curator` package.
- No duplicate `curated_memory` tool.
- No project-local timer extension.

Semantic merge/delete should first create `REVIEW.md` entries so user memory is not silently lost.

## Future Work

- Add file locking around curator writes for concurrent pi and service runs.
- Add macOS launchd and Windows Task Scheduler backends.
- Add uninstall lifecycle cleanup if pi/package installation reliably runs uninstall hooks.
- Add review-assisted semantic merge suggestions that only write to `REVIEW.md` by default.
