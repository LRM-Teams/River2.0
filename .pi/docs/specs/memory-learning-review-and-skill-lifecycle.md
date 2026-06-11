# Memory Learning, Review, and Skill Lifecycle Spec

## Objective

Make `@jhp/pi-memory` learn durable memories and skill-worthy capabilities without polluting long-term memory, overproducing skill drafts, or coupling skill generation to unstable workflow/loop experiments.

The system should capture candidate learnings from sessions, errors, fixes, and repeated work; route them through `REVIEW.md`; merge or retire duplicates; and promote stable, useful knowledge into long-term memory or skill drafts when evidence justifies it. Memory and skill are independent promotion targets: one candidate may promote to one, both, or neither.

Workflow and loop artifacts are intentionally out of scope for this spec. They are covered by `.pi/docs/specs/workflow-loop-review-and-runtime-lifecycle.md` because workflow/loop design is still unstable and should not block memory/skill lifecycle work.

## Current State

`@jhp/pi-memory` already provides:

- Memory files under `~/.pi/agent/memory/`.
- `MEMORY.md`, `USER.md`, `STATE.md`, `REVIEW.md`, `SCRATCHPAD.md`, and daily logs.
- Session shutdown summaries written to daily logs.
- Lightweight `/new` and `/fork` handoffs written to daily logs.
- Context injection from memory files.
- qmd-backed memory search.
- A deterministic curator with exact dedupe, event lifecycle updates, temporary review, quota reset, and JSONL audit logs.
- Optional external daily curator service via systemd user timer or cron.

Current implementation status:

- Session shutdown can extract structured learning candidates from conversation text into `REVIEW.md`.
- Candidate writes are review-first and dedupe by `kind + normalized signature`.
- Durable preferences, project facts, and concise lessons can become `memory_promotion` proposals.
- Skill-worthy repeated candidates can become `skill_promotion` proposals and approved disabled skill drafts.
- Approval/rejection tools manage proposed items without deleting review evidence.
- Optional YOLO switches can auto-approve newly created memory promotions or disabled skill draft creation.
- `/reload` and `/resume` remain quiet; `/new` and `/fork` continue lightweight handoffs.

Current limitations accepted for this iteration:

- Error/fix capture is based on conversation-text extraction, not deterministic tool-event graph analysis.
- Skill and memory learning mutations are reflected in files and proposal status, but are not yet fully represented in a unified JSONL audit schema.
- The curator avoids semantic merge/delete, which is correct, and only performs conservative review-oriented updates.

## Design Principles

1. Review first, promote later.
2. Do not automatically write noisy facts into `MEMORY.md`.
3. Do not automatically enable skills.
4. Do not modify memory or skills when scanning finds no clear improvement.
5. Prefer merging and incrementing evidence over adding new entries.
6. Never delete user memory or enabled skills automatically.
7. Every automatic mutation must have an audit record.
8. LLM output may propose candidates, but deterministic validators decide where they can be written.
9. Promotion requires evidence, not a single interesting session.
10. Stale items are downgraded or archived, not silently removed.
11. Memory and skill promotions are parallel tracks, not a pipeline.
12. Workflow/loop artifacts are not prerequisites for skill drafts.

## Promotion Model

Evidence enters one shared review pool and can independently become memory or a skill draft.

```text
session / daily / tool evidence
        |
        v
REVIEW candidates
   |        |
   v        v
memory   skill draft
```

Promotion target definitions:

- Memory: durable facts, preferences, project facts, and concise lessons that should be searchable or injected as context.
- Skill: agent capability packages with trigger descriptions, heuristics, tool-use guidance, safety boundaries, and reusable domain methods.

A candidate can produce multiple proposals when appropriate. For example, a repeated debugging method can produce a concise memory lesson and a skill proposal for when/how an agent should apply that diagnostic capability.

## Data Model

### Review Candidate Entry

Candidate entries live in `REVIEW.md` as structured entries separated by `§`.

Example:

```md
[type:review status:candidate id:rev_20260610_001 kind:bug_fix confidence:high seen:1 first_seen:2026-06-10 last_seen:2026-06-10]
Signature: npm run check failed after adding pi-memory lifecycle tests.
Root cause: test message mocks did not match the pi message shape.
Fix: construct branch entries with role, text content, and timestamp.
Validation: npm test and npm run check passed.
Files: .pi/packages/pi-memory/index.ts, .pi/packages/pi-memory/test/transition-handoff.test.ts
```

Supported metadata:

- `type`: always `review` for candidates and proposals.
- `status`: `candidate`, `merged`, `proposed`, `approved`, `rejected`, `archived`, `stale`, `needs_review`.
- `id`: stable candidate/proposal id used for audit, approval, rejection, and source references.
- `kind`: single primary entry type: `bug_fix`, `skill_candidate`, `preference`, `project_fact`, `memory_promotion`, `memory_merge`, `skill_promotion`.
- `confidence`: `low`, `medium`, `high`.
- `seen`: integer count of matching observations.
- `first_seen`: `YYYY-MM-DD`.
- `last_seen`: `YYYY-MM-DD`.
- `source`: `session_shutdown`, `transition_handoff`, `tool_failure`, `curator`, `manual`.
- `target_hints`: optional comma-separated extractor hints limited to `memory` and `skill`; hints are not approval-ready routing decisions.
- `promotion_targets`: optional comma-separated router decisions after deterministic validation, limited to `memory` and `skill`.
- `promotes_to`: optional memory target or skill draft path for a target-specific proposal.
- `source_candidate_ids`: optional comma-separated ids for proposals generated from review candidates.
- `evidence`: optional compact reference to commands, files, or daily log entries.

### Skill Draft

Generated skills must start as drafts.

Suggested path:

```text
~/.pi/agent/skill-drafts/<slug>/SKILL.md
```

Enabled skills remain in normal pi skill locations only after explicit user approval:

```text
.pi/skills/<slug>/SKILL.md
~/.pi/agent/skills/<slug>/SKILL.md
```

Skill draft metadata should include source candidates and evidence counts. Skill drafts may mention related workflow/loop run artifacts by id, but they must not require an approved workflow artifact to exist.

## Candidate Extraction

### Session Shutdown Extractor

After writing the daily summary, run an optional extractor over the current session branch.

Inputs:

- Recent conversation transcript.
- Tool calls and results if available in the session branch.
- Files changed if available from session metadata or git diff summary.
- Existing `REVIEW.md` candidates for duplicate detection.

Outputs:

- Zero or more candidate entries.
- Each candidate must have `kind`, `confidence`, and evidence.
- Candidates below confidence threshold are dropped.
- Candidates are written to `REVIEW.md`, never directly to `MEMORY.md`.

Candidate types:

- `bug_fix`: A concrete error/fix/validation pattern.
- `skill_candidate`: A reusable agent capability or method with a clear trigger.
- `preference`: A durable user preference candidate.
- `project_fact`: A project-specific fact that may belong in memory or docs.

Candidate classification should allow multiple target hints. `kind` remains a single primary entry type; `target_hints` and later `promotion_targets` carry multi-target routing such as `memory,skill` when the same observation is both memorable and skill-worthy.

### Error/Fix Capture

For this iteration, error/fix learning is extracted from conversation text rather than from deterministic tool event graphs.

The extractor should still be conservative: it should only emit a `bug_fix` candidate when the conversation indicates a verified sequence:

```text
failure -> edit or action -> successful validation
```

Do not create a `bug_fix` candidate for a standalone failure with no stated fix and validation.

Useful fields to preserve when visible in conversation text:

- Failing command.
- Error signature.
- Root cause when inferable.
- Fix action.
- Changed files.
- Validation command.
- Validation result.

Deterministic tool-call parsing is explicitly deferred. A later implementation may inspect structured tool calls/results directly, but that is not required for the current accepted lifecycle.

## Curator Enhancements

The existing deterministic curator remains the foundation. Add conservative review-oriented rules.

### Candidate Deduplication

- Normalize candidate signatures.
- If a new candidate matches an existing candidate, update `seen` and `last_seen` instead of appending.
- Preserve the highest confidence seen.
- Append evidence only if it is new and compact.

### Candidate Staleness

- Low-confidence candidates with no repeat observations after a configurable window become `status:archived`.
- Medium/high candidates become `status:stale` or `needs_review` before archival.
- No candidate is deleted automatically.

### Parallel Promotion Router

For each candidate, route independently to zero or more promotion targets:

- `memory`: durable fact, preference, project fact, or concise lesson.
- `skill`: reusable agent capability with a clear trigger and safe operating bounds.

Extractor `target_hints` are advisory only. The router writes validated `promotion_targets` only when deterministic checks or explicit user input justify a target.

### Memory Promotion Proposal

For durable facts/preferences/project facts and concise lessons:

- Curator may create `kind:memory_promotion` or `kind:memory_merge` proposals.
- It should not directly write to `MEMORY.md` unless the rule is deterministic and explicitly approved by configuration.
- If an existing memory already covers the fact, propose updating evidence/count instead of adding a new memory.
- Memory proposals do not require skill proposals.

### Skill Promotion Proposal

For skill candidates:

- Require reusable capability guidance, not just a command checklist.
- Require a clear trigger condition suitable for skill `description` frontmatter.
- Require low failure/noise rate or explicit user approval.
- Require bounded behavior: validation signal, stop condition, and safe fallback when applicable.
- Generate a skill draft only, not an enabled skill.
- If similar skills exist, propose merge/update instead of creating another skill.
- Skill proposals do not require memory proposals or workflow artifacts.

## Memory And Skill Reuse Controls

### Memory Growth Controls

- Candidate entries are not injected into normal context unless explicitly requested or searched.
- `status:merged` is reserved for explicit compaction or manual merge tombstones; normal duplicate detection updates the existing candidate in place instead of appending merged duplicate entries.
- `REVIEW.md` candidates can be compacted by replacing many raw candidates with one merged candidate and archival references.
- Long-term memory promotion should prefer concise facts with links to detailed daily/review evidence.
- Old, unused, or superseded memories should be marked for review, not deleted.

### Skill Growth Controls

- One-off project procedures must not become global skills just because they are useful once.
- Skills must have a clear `description` trigger to avoid broad accidental activation.
- Skill drafts track `source_candidates`, `success_count`, `failure_count`, and `last_used`.
- Skills with repeated misfires should be marked `needs_review` and proposed for narrower triggers or archival.
- Similar skill drafts should merge before user approval.
- A skill can be proposed directly from `skill_candidate` evidence without a workflow artifact.
- Workflow/loop drafts may inform skill evidence, but unstable workflow/loop design must not block memory/skill promotion.

## Scanning Behavior

Daily scans should be read-mostly.

The curator may mutate automatically only for deterministic, low-risk operations:

- Exact duplicate candidate merge.
- Status timestamp updates.
- Event/quota/temporary lifecycle rules already supported.
- Candidate `seen`/`last_seen` updates.
- Audit log writes for real mutations; no-op audit records are optional and must be configurable.

The curator must not automatically:

- Delete memory.
- Delete enabled skills.
- Enable skill drafts.
- Rewrite enabled skills.
- Promote candidates into long-term memory without policy approval.
- Create skill draft files when no strong evidence exists.
- Create or modify workflow/loop artifacts; those are owned by the workflow/loop lifecycle spec.

When no useful action exists, the curator should report no-op and leave memory, review, workflow, and skill files unchanged. No-op audit records may be written only when explicitly configured; default no-op tests should expect no file changes.

## Configuration

Suggested environment variables:

- `PI_MEMORY_LEARNING=off|review|auto-review` default `review`.
- `PI_MEMORY_LEARNING_MIN_CONFIDENCE=medium`.
- `PI_MEMORY_MEMORY_PROMOTION_SEEN=2`.
- `PI_MEMORY_SKILL_PROMOTION_SEEN=3`.
- `PI_MEMORY_SKILL_DRAFTS=off|review` default `review`.
- `PI_MEMORY_REVIEW_STALE_DAYS=30`.
- `PI_MEMORY_REVIEW_ARCHIVE_DAYS=90`.

Suggested tool/command additions:

- `memory_learning_review`: list candidates and proposals.
- `memory_learning_approve`: approve a target-specific memory or skill proposal by exact id.
- `memory_learning_reject`: reject or archive a candidate/proposal.
- `memory_skill_drafts`: list generated skill drafts.

## Safety And Audit

Curator lifecycle patches continue to write `audit/curator.jsonl` records.

Learning mutations in this iteration are audited primarily through `REVIEW.md` status transitions and proposal metadata:

- source candidate ids
- proposal ids
- approval/rejection/archive status
- `promotes_to` target
- `approved_at` or `reviewed_at` timestamps when applicable
- applied target/path notes in approved proposal bodies

A later implementation may add a unified JSONL audit schema for all learning mutations. That is deferred and not required for the current accepted behavior.

LLM-generated candidates must be schema-validated. Invalid output is discarded or written as a low-confidence review note only if useful.

## Acceptance Criteria

- Session shutdown can produce review candidates without writing directly to long-term memory.
- `/reload` and `/resume` remain quiet.
- `/new` and `/fork` continue writing lightweight handoffs.
- Curator can merge duplicate candidates without semantic data loss.
- Curator can mark stale candidates without deleting them.
- Error/fix candidates require a successful validation signal visible in conversation text.
- Memory promotion proposals are created only when evidence thresholds or explicit approval requirements are met.
- Skill draft proposals are created only when capability evidence thresholds are met and never enabled automatically.
- Memory and skill proposals are independent; neither requires the other.
- Workflow/loop artifacts are out of scope and cannot block memory or skill promotion.
- Running the curator on unchanged memory produces no memory, review, workflow, or skill file changes; optional no-op audit writes require explicit configuration.
- Tests cover no-op scans, duplicate candidate merge, stale candidate marking, memory proposal/approval, skill draft proposal/approval, and reject/archive handling.

## Non-Goals

- No autonomous deletion of user memory.
- No autonomous deletion of enabled skills.
- No public skill hub publishing.
- No workflow artifact lifecycle.
- No loop runtime/harness lifecycle.
- No always-on background scanning of private files outside configured memory and skill draft directories.
- No direct LLM patch application to memory files without deterministic validation.
