# Memory Curator Daemon Implementation Plan

## Objective

Turn the current local `memory-curator.ts` prototype into a reusable, testable memory curator with a shared core, pi extension entry, CLI entry, and optional daemon. Keep `pi-memory` installed during the migration.

## Current State

- `memory-curator.ts` is a project-local extension at `.pi/extensions/memory-curator.ts`.
- The curator now uses the unified memory root: `~/.pi/agent/memory`.
- `/workspaces/gaia/pi-mono/.pi/memory` is a symlink to `~/.pi/agent/memory`.
- The old curator-only directory `~/.pi/memory` was archived.
- Current curation rules are deterministic but minimal.
- No daemon, lock, audit log, package boundary, or structured reviewer exists yet.

## Phase 0: Preserve Working State

1. Keep `pi-memory` installed and enabled.
2. Keep current `.pi/extensions/memory-curator.ts` working until the new package is ready.
3. Do not remove `memory_read`, `memory_write`, `memory_search`, `scratchpad`, daily log, or long-term memory support.
4. Add a note in any future README that curator is additive, not a replacement for `pi-memory` yet.

## Phase 1: Extract Shared Core

Create a package-like local structure first. Suggested path for initial work:

```text
.pi/packages/pi-memory-curator/
```

Files:

```text
.pi/packages/pi-memory-curator/src/core/metadata.ts
.pi/packages/pi-memory-curator/src/core/policy.ts
.pi/packages/pi-memory-curator/src/core/patch.ts
.pi/packages/pi-memory-curator/src/core/curate.ts
.pi/packages/pi-memory-curator/src/store/types.ts
.pi/packages/pi-memory-curator/src/store/file-store.ts
.pi/packages/pi-memory-curator/src/index.ts
```

Tasks:

1. Move metadata parsing and rendering into `metadata.ts`.
2. Move deterministic lifecycle rules into `policy.ts`.
3. Define `MemoryPatch` and patch validation in `patch.ts`.
4. Define `MemoryStore` interface in `store/types.ts`.
5. Implement file-backed store in `store/file-store.ts`.
6. Implement `runMemoryCuratorOnce()` in `curate.ts`.
7. Keep behavior equivalent to current extension before adding new features.

Acceptance criteria:

- Existing planned-event behavior still works.
- Plain text entries are left unchanged.
- Past entries are filtered from context summaries.
- Core can run without pi extension APIs.

## Phase 2: Add Tests

Add targeted tests for core behavior.

Suggested test files:

```text
.pi/packages/pi-memory-curator/test/metadata.test.ts
.pi/packages/pi-memory-curator/test/policy.test.ts
.pi/packages/pi-memory-curator/test/curate.test.ts
.pi/packages/pi-memory-curator/test/file-store.test.ts
```

Test cases:

1. Parses `[type:event status:planned date:2026-06-06]` metadata.
2. Leaves malformed metadata untouched.
3. Marks past planned event as `status:past`.
4. Marks same-day event as `status:today` if policy enables it.
5. Keeps future event as `status:planned`.
6. Leaves plain date-like text untouched.
7. Resets quota when reset date has passed.
8. Deduplicates exact duplicate entries only.
9. Writes file updates atomically.
10. Produces deterministic patch output.

Acceptance criteria:

- Tests cover all current lifecycle rules.
- No test requires a real LLM.
- File-store tests use temp directories.

## Phase 3: Add Audit Log

Files:

```text
.pi/packages/pi-memory-curator/src/core/audit.ts
```

Tasks:

1. Define `AuditLog` interface.
2. Implement JSONL audit writer.
3. Add `runId` to each curator run.
4. Log every mutation with old/new text, target, reason, timestamp, and actor.
5. Do not log no-op entries.

Example audit path:

```text
~/.pi/agent/memory/audit/curator.jsonl
```

Acceptance criteria:

- Every mutation has exactly one audit record.
- Audit writes append-only JSONL.
- Failed runs do not write partial audit records for unapplied patches.

## Phase 4: Add Locking

Files:

```text
.pi/packages/pi-memory-curator/src/core/lock.ts
```

Tasks:

1. Implement lock acquisition using `.curator.lock` in the memory root.
2. Include pid, hostname, acquiredAt, and staleAfter.
3. Refuse to run when an active lock exists.
4. Recover stale locks safely.
5. Release lock after successful or failed run.

Acceptance criteria:

- Two concurrent `runOnce()` calls do not both write.
- Stale lock can be recovered.
- Lock file is removed or refreshed correctly.

## Phase 5: Replace Extension Internals With Shared Core

Modify:

```text
.pi/extensions/memory-curator.ts
```

Tasks:

1. Keep extension public commands the same.
2. Import or copy shared core functions from the local package path.
3. Replace in-file curation logic with `runMemoryCuratorOnce()`.
4. Keep `before_agent_start` context injection in the extension.
5. Keep `session_start` catch-up optional, but do not rely on it for guaranteed scheduling.
6. Ensure `/memory-curate` writes audit records.

Acceptance criteria:

- `/memory-read` still works.
- `/memory-curate` calls shared core.
- Context injection still excludes `status:past` and `status:archived` entries.
- No behavior regression from current prototype.

## Phase 6: Add CLI

Files:

```text
.pi/packages/pi-memory-curator/src/cli.ts
```

Commands:

```bash
pi-memory-curator run-once --memory-dir ~/.pi/agent/memory
pi-memory-curator daemon --schedule "0 3 * * *" --memory-dir ~/.pi/agent/memory
```

Tasks:

1. Parse CLI args.
2. Support `--memory-dir`.
3. Support `--audit` override.
4. Support `--dry-run` for previewing patches.
5. Support `--json` output for scripts.
6. Exit non-zero on lock failure only if `--strict-lock` is set.

Acceptance criteria:

- `run-once` works without pi running.
- `run-once --dry-run` prints patches and does not write.
- CLI uses the same core as the extension.

## Phase 7: Add Daemon

Files:

```text
.pi/packages/pi-memory-curator/src/daemon.ts
```

Tasks:

1. Implement `startMemoryCurator()`.
2. Support cron-like schedule string.
3. Run `runOnce()` on schedule.
4. Log each run result.
5. Expose `stop()` for graceful shutdown.
6. Keep daemon hosting external: pm2, Docker, k8s, systemd, or another Node service.

Acceptance criteria:

- Daemon runs `runOnce()` at schedule time.
- Daemon can be stopped cleanly.
- Daemon does not require pi interactive mode.
- Daemon uses lock to avoid concurrent writes.

## Phase 8: Add Optional LLM Reviewer

Files:

```text
.pi/packages/pi-memory-curator/src/reviewer/types.ts
.pi/packages/pi-memory-curator/src/reviewer/noop-reviewer.ts
.pi/packages/pi-memory-curator/src/reviewer/llm-reviewer.ts
```

Tasks:

1. Define `MemoryReviewer` interface.
2. Default to no-op reviewer.
3. Add optional LLM reviewer that returns structured patches only.
4. Validate all reviewer patches through deterministic validator.
5. Send low-confidence or invalid patches to `REVIEW.md` instead of applying.

Acceptance criteria:

- LLM cannot directly write memory files.
- Invalid patch schema is rejected.
- Low-confidence patch goes to review queue.
- Deterministic pass works without reviewer.

## Phase 9: Improve Memory Metadata Adoption

Tasks:

1. Add `/memory-review plain-state` or equivalent to find date-like plain entries without metadata.
2. Add a command to convert a plain entry to metadata with user confirmation.
3. Update agent prompt/tool descriptions to prefer metadata for time-sensitive facts.
4. Add examples for event, temporary, quota, and review entries.

Acceptance criteria:

- Plain entries are not automatically lifecycle-mutated.
- User can manually convert plain state entries to structured metadata.
- New time-sensitive entries are more likely to be written in curator-compatible format.

## Phase 10: Decide Whether to Replace pi-memory

Only consider removing or replacing `pi-memory` after the curator package supports equivalent functionality or a deliberate reduced scope.

Checklist before replacement:

- `memory_read` equivalent exists.
- `memory_write` equivalent exists.
- `memory_search` equivalent exists or is intentionally dropped.
- `scratchpad` equivalent exists or is intentionally dropped.
- daily log support exists or is intentionally dropped.
- migration script exists.
- old tool names either remain compatible or have a documented transition.

Acceptance criteria:

- No session startup memory regression.
- Existing user memory is migrated or preserved.
- Commands and tools used by the harness still resolve.

## Operational Notes

To run without pi open, use one of:

```bash
pm2 start "pi-memory-curator daemon --schedule '0 3 * * *' --memory-dir ~/.pi/agent/memory" --name pi-memory-curator
```

```bash
systemd --user enable --now pi-memory-curator.service
```

```bash
docker run -v ~/.pi/agent/memory:/memory pi-memory-curator daemon --memory-dir /memory
```

These are deployment examples only. The package should not silently install a daemon.

## Rollback Plan

1. Stop daemon if running.
2. Disable new extension or restore old `.pi/extensions/memory-curator.ts`.
3. Keep `pi-memory` installed throughout rollback.
4. Restore files from audit log or filesystem backup if needed.
5. Because default policy avoids deletion, most rollback should only require reverting status changes.

## First Implementation Slice

Start with the smallest useful slice:

1. Extract metadata parser.
2. Extract file store.
3. Extract deterministic `runOnce()`.
4. Add audit JSONL.
5. Wire `/memory-curate` to shared core.
6. Add `run-once` CLI.

Do not build daemon or LLM reviewer until this slice is stable.
