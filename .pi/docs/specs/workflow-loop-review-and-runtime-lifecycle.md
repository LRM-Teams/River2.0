# Workflow And Loop Review Lifecycle Spec

## Objective

Define an experimental lifecycle for workflow and loop artifacts without coupling them to the memory/skill promotion path.

Workflow and loop design is intentionally less stable than memory/skill learning. The system should capture workflow-shaped and loop-shaped evidence into reviewable run artifacts, preserve useful patterns, and promote only stable, repeated, bounded procedures into workflow drafts. Dynamic workflows and loops start as ephemeral harnesses, not durable knowledge.

Memory and skill lifecycle work is covered by `.pi/docs/specs/memory-learning-review-and-skill-lifecycle.md`.

## Definitions

- Static workflow: a stable, repeatable procedure with known steps, preconditions, validation, and failure handling.
- Dynamic workflow: a task-specific harness generated or assembled for the current problem, often using subagents, fan-out, verification, or pipelines.
- Loop: an iterative control structure inside a workflow or agent runtime, bounded by goal criteria, budgets, stop rules, and validation signals.
- Workflow run artifact: an ephemeral record of a generated or executed workflow/loop, kept for review and possible future promotion.

Loop is not a fourth final promotion product. It is a control pattern that can appear inside dynamic workflows, static workflows, or skill evidence.

## Design Principles

1. Workflow/loop artifacts are experimental and review-first.
2. Dynamic workflow runs are ephemeral by default.
3. Do not promote a one-off harness into a durable workflow automatically.
4. Every loop must have a goal, budget, and stop rule.
5. Producer and verifier should be isolated for high-risk tasks.
6. Workflow promotion requires repeated value or explicit user approval.
7. Workflow artifacts must include failure handling, not only happy-path steps.
8. Generated harnesses must be auditable and resumable where possible.
9. Untrusted content must be quarantined from action-capable agents.
10. Workflow/loop instability must not block memory or skill promotion.

## Relationship To Memory And Skill

Workflow/loop lifecycle is separate from memory/skill lifecycle:

```text
session / task evidence
        |
        v
workflow run artifacts
        |
        v
workflow review candidates
        |
        v
workflow draft
```

Cross-links are allowed but non-blocking:

- A memory candidate may reference a workflow run as evidence.
- A skill draft may reference a workflow run as supporting evidence.
- A workflow draft may reference memory facts or skill drafts.
- None of these references should require the other artifact to exist or be approved.

## Workflow Patterns

Supported pattern tags:

- `classify_and_act`: classify the task, then route to specialized actions or agents.
- `fan_out_and_synthesize`: split independent work across agents, then synthesize results.
- `adversarial_verification`: use an independent verifier that did not produce the original work.
- `generate_and_filter`: generate many candidates, then filter with a rubric.
- `tournament`: compare candidates pairwise instead of absolute scoring.
- `loop_until_done`: repeat until acceptance criteria, budget exhaustion, or stop rule.
- `pipeline`: stream items through stages when later work does not need all prior results.
- `parallel_barrier`: fan out work and wait for all results before continuing.

Pattern tags are descriptive. They do not imply promotion.

## Run Artifact Model

Dynamic workflow and loop execution should first write run artifacts under a non-injected location.

Suggested path:

```text
~/.pi/agent/workflow-runs/<run-id>/
```

Suggested files:

```text
workflow.md          # human-readable plan/harness summary
workflow.js          # optional generated executable harness
inputs.json          # sanitized input metadata when safe
outputs.json         # structured outputs when safe
summary.md           # outcome, validation, failures, costs
review.md            # reviewer findings if any
```

Run artifacts must not be injected into normal context unless explicitly searched or requested.

## Review Candidate Entry

Workflow review candidates live in `REVIEW.md` as structured entries separated by `§`.

Example:

```md
[type:review status:candidate id:wf_20260610_001 kind:workflow_candidate confidence:medium seen:1 first_seen:2026-06-10 last_seen:2026-06-10]
Signature: fan-out security review with independent verifier over changed files.
Patterns: fan_out_and_synthesize,adversarial_verification
Run: ~/.pi/agent/workflow-runs/20260610-security-review
Validation: reviewer found no high-severity missed findings.
Stop Rules: max 50 files, max 3 review iterations, stop when all high findings resolved or budget exhausted.
```

Supported metadata:

- `type`: always `review`.
- `status`: `candidate`, `proposed`, `approved`, `rejected`, `archived`, `stale`, `needs_review`.
- `id`: stable candidate/proposal id.
- `kind`: `workflow_candidate`, `workflow_promotion`, `workflow_merge`, `loop_pattern`.
- `confidence`: `low`, `medium`, `high`.
- `seen`: integer count of matching observations.
- `first_seen`: `YYYY-MM-DD`.
- `last_seen`: `YYYY-MM-DD`.
- `source`: `workflow_run`, `session_shutdown`, `manual`, `curator`.
- `workflow_patterns`: comma-separated pattern tags.
- `dynamic_workflow`: `true` or `false`.
- `isolation`: `none`, `fresh-context`, `fork-context`, `worktree`, `remote`.
- `budget`: compact budget reference, such as max agents, iterations, tokens, or wall time.
- `stop_rules`: compact stop condition summary.
- `review_strategy`: `none`, `self_check`, `independent_review`, `adversarial_review`, `tournament`.
- `run_artifact`: optional workflow run artifact path.
- `promotes_to`: optional workflow draft path for target-specific proposals.
- `source_candidate_ids`: optional comma-separated ids for proposals.

## Workflow Draft Artifact

Workflow drafts are durable, reviewable procedures. They are not always injected into context.

Suggested global path:

```text
~/.pi/agent/workflows/<slug>.md
```

Optional project-local path:

```text
.pi/docs/workflows/<slug>.md
```

Workflow template:

```md
# <workflow-slug>

## Status
Draft | Active | Needs Review | Archived

## Pattern
classify_and_act | fan_out_and_synthesize | adversarial_verification | generate_and_filter | tournament | loop_until_done | pipeline | parallel_barrier

## When To Use
Short trigger description.

## Entry Conditions
Required repo/package/context state.

## Agent Topology
- agents:
- model selection:
- isolation:
- shared state:

## Steps
1. Step one.
2. Step two.

## Loop And Stop Rules
- goal:
- max iterations:
- max agents:
- max tokens/wall time:
- stop when:
- stop and ask user when:

## Verification Strategy
Independent reviewer, adversarial pass, tournament, validation commands, or manual review.

## Failure Handling
Known failure modes, fallback paths, and when to archive or escalate.

## Validation
Commands or checks that prove success.

## Observability
Progress events, summaries, logs, or artifacts to preserve.

## Evidence
- first_seen:
- last_seen:
- success_count:
- failure_count:
- source_runs:

## Notes
Important caveats.
```

## Dynamic Workflow Controls

Dynamic workflows may spawn subagents or stages, but must specify:

- Goal and acceptance criteria.
- Pattern tags.
- Agent topology.
- Context isolation policy.
- Model selection policy.
- Shared state rules.
- Budget limits.
- Stop rules.
- Verification strategy.
- Untrusted input quarantine plan when needed.

Dynamic workflow harnesses should be saved only as run artifacts unless the user explicitly requests saving or repeated successful evidence justifies promotion.

## Loop Controls

Every loop must define:

- Hard goal or acceptance criteria.
- Validation signal per iteration or per phase.
- Maximum iterations or wall-clock budget.
- No-progress stop rule.
- User-interrupt behavior.
- Finalization behavior when budget is exhausted.

A loop without a stop rule is invalid. A loop that stops on vague soft completion is not promotion-ready.

## Verification Controls

High-risk workflows should avoid self-verification:

- Producer agents create or modify outputs.
- Verifier agents inspect outputs against criteria.
- Verifiers should not inherit producer working context unless necessary.
- Verification results should be preserved in run artifacts.
- Failed verification should create residual risk notes or another bounded repair loop.

## Promotion Rules

Workflow promotion can create a `kind:workflow_promotion status:proposed` review entry when at least one is true:

- The pattern has repeated successful use.
- The user explicitly asks to save the workflow.
- The run artifact demonstrates strong reusable value with clear bounds.

Promotion requires:

- Clear trigger.
- Entry conditions.
- Steps or topology.
- Budget and stop rules.
- Verification strategy.
- Failure handling.
- Evidence references.

Promotion must not:

- Create enabled skills.
- Modify long-term memory.
- Depend on memory/skill proposal approval.
- Save untrusted raw input into durable workflow files.

## Scanning Behavior

Workflow/loop scans are read-mostly.

The curator may mutate automatically only for deterministic, low-risk operations:

- Exact duplicate workflow candidate merge.
- Candidate `seen`/`last_seen` updates.
- Status timestamp updates.
- Stale/archive transitions.
- Audit log writes for real mutations.

The curator must not automatically:

- Execute generated workflow code.
- Enable or schedule loops.
- Create workflow drafts without approval or strong policy.
- Modify memory or skill files.
- Promote a dynamic run artifact just because it succeeded once.

## Configuration

Suggested environment variables:

- `PI_WORKFLOW_LEARNING=off|review|auto-review` default `off` until the design stabilizes.
- `PI_WORKFLOW_RUN_ARTIFACTS=off|review` default `review`.
- `PI_WORKFLOW_PROMOTION_SEEN=3`.
- `PI_WORKFLOW_MAX_RUN_ARTIFACTS=100`.
- `PI_WORKFLOW_REVIEW_STALE_DAYS=30`.
- `PI_WORKFLOW_REVIEW_ARCHIVE_DAYS=90`.

Suggested tool/command additions:

- `workflow_run_list`: list workflow run artifacts.
- `workflow_run_read`: inspect one run artifact.
- `workflow_review_list`: list workflow candidates and proposals.
- `workflow_approve`: approve a workflow proposal by exact id.
- `workflow_reject`: reject/archive a workflow candidate or proposal.
- `workflow_list`: list workflow drafts.

## Safety And Audit

Every mutation writes to an audit log with:

- run id
- timestamp
- actor
- target file or artifact path
- old entry or path
- new entry or path
- reason
- confidence
- source run/candidate ids if available

Generated workflow code must be treated as untrusted until reviewed. It should not run with broader permissions than the parent session grants.

## Acceptance Criteria

- Workflow/loop lifecycle can be disabled independently from memory/skill learning.
- Dynamic workflow runs are saved as ephemeral run artifacts, not durable workflows by default.
- Workflow candidates can record pattern tags, isolation, budgets, stop rules, and review strategy.
- Workflow promotion proposals require bounded behavior and verification strategy.
- Loop candidates without stop rules are rejected or marked `needs_review`.
- High-risk workflow proposals can require independent/adversarial verification evidence.
- Workflow draft creation is explicit and reviewable.
- Workflow/loop scans do not modify memory or skill files.
- Memory/skill promotion does not depend on workflow/loop approval.

## Non-Goals

- No automatic execution of generated workflow code.
- No autonomous scheduling of loops.
- No enabled skill creation.
- No long-term memory mutation.
- No public workflow marketplace.
- No guarantee that the workflow/loop schema is stable before explicit adoption.
