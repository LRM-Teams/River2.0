# Autogoal Loop Orchestrator Spec

## Objective

Define a single user-facing `/autogoal` command that runs long coding tasks autonomously, safely, and resumably.

`/autogoal` combines four capabilities behind one simple entrypoint:

- Goal-mode persistence: keep working until the objective is verified complete, blocked, paused, dropped, or interrupted.
- Bounded loop runtime: classify, plan, act, verify, repair, and stop by explicit budgets and stop rules.
- Context handoff: monitor context usage, create structured checkpoints, and continue in a fresh session when needed.
- Optional subagent orchestration: let the agent decide when independent scouting, implementation, or review is useful.

The user should only need to remember:

```text
/autogoal <task>
```

All routing, review, subagent use, handoff timing, and loop behavior are implementation details.

## Relationship To Existing Features

`/autogoal` is an orchestrator, not a replacement for lower-level primitives:

- It may reuse goal-mode behavior and completion discipline.
- It may reuse subagent tooling when installed.
- It should align with `.pi/docs/specs/workflow-loop-review-and-runtime-lifecycle.md` by treating dynamic loops as bounded, auditable run artifacts.
- It should not expose a separate public `/loop` command in the first version.
- It should not require the user to choose modes such as `--review`, `--sidecar`, `--parallel`, or `--solo`.

If internal commands or tools are needed by the extension API, they must remain private implementation details and should not be documented as user-facing commands.

## Non-Goals

- Do not add multiple public commands for common use.
- Do not require users to remember flags or orchestration terminology.
- Do not create an always-on background worker that continues after pi exits.
- Do not auto-commit, auto-push, post remote comments, or publish packages.
- Do not automatically promote workflow runs into durable workflows or skills.
- Do not let subagents compete to modify the same main worktree without isolation.
- Do not continue indefinitely without budgets, validation signals, or stop rules.

## User Experience

### Start

```text
/autogoal fix the failing auth tests and keep going until relevant checks pass
```

Expected behavior:

1. The command records the objective.
2. The agent classifies the task and chooses a loop strategy.
3. The agent starts work immediately.
4. The agent continues across turns until the objective is verified complete or a stop rule fires.
5. If context becomes high, the agent checkpoints and continues in a new session without the user manually running `/new`.

### Resume After Session Switch

When `/autogoal` creates a new session, the user should see a concise continuation message, not a pile of raw logs. The new session should receive enough structured context to continue without reading the full old session.

### Completion

`/autogoal` can only complete after current-state verification. The agent must have direct evidence such as:

- relevant files read after edits,
- targeted tests or checks run,
- reviewer/verifier findings resolved or explicitly accepted as residual risk,
- no known acceptance criteria left unresolved.

## Public Command Surface

Only one public command is required:

```text
/autogoal <objective>
```

Optional convenience behavior may be accepted through natural language, not flags:

```text
/autogoal continue the previous autogoal task
/autogoal stop the current autogoal
/autogoal show current autogoal status
```

The implementation may parse these phrases, but the primary supported path is `/autogoal <objective>`.

## Autogoal State

Each active run should have a state record:

```ts
type AutogoalState = {
  id: string;
  objective: string;
  status: "active" | "paused" | "switching" | "complete" | "blocked" | "dropped";
  phase: "classify" | "plan" | "act" | "verify" | "repair" | "review" | "handoff";
  startedAt: number;
  updatedAt: number;
  parentSession?: string;
  currentSession?: string;
  loop: LoopBudget;
  context: ContextPolicy;
  subagents: SubagentPolicy;
  checkpoints: string[];
  runArtifact?: string;
};
```

State should be persisted with session entries and/or an extension-owned state file so it survives reloads and session replacement.

## Loop Runtime

`/autogoal` uses a bounded loop instead of a vague "keep trying" instruction.

Default loop phases:

```text
classify -> plan -> act -> verify -> repair/review -> verify -> complete
```

The loop may skip phases for simple tasks, but every run must have:

- objective,
- acceptance criteria,
- validation signal,
- maximum iteration budget,
- no-progress stop rule,
- finalization behavior.

### Default Budgets

Suggested defaults:

- maximum autonomous turns per session: 12,
- maximum repair attempts for the same failure: 3,
- maximum subagent jobs per run before asking or stopping: 4,
- maximum active subagents at once: 2,
- no-progress stop: 2 consecutive turns without new evidence, edits, or validation movement.

Budgets should be configurable later, but not exposed as first-version command flags.

### Stop Rules

Stop and report instead of continuing when any of these is true:

- acceptance criteria cannot be inferred safely,
- required credentials or permissions are missing,
- validation is impossible in the current environment,
- the same validation failure repeats after the repair budget is exhausted,
- context switching fails,
- subagent results conflict and the main agent cannot resolve them safely,
- user interrupts or changes the objective.

## Context Threshold Policy

`/autogoal` should not switch sessions at 60% context. It should use staged thresholds:

```text
60% = prepare
75% = checkpoint required soon
85% = checkpoint plus new session
```

### 60% Prepare Threshold

At or above 60%:

- keep working in the current session,
- become more concise,
- track current phase and next validation target,
- optionally create a lightweight checkpoint if the remaining task is clearly long.

### 75% Handoff Threshold

At or above 75%:

- force a structured checkpoint before starting broad new work,
- finish a small in-flight validation or edit if it is safer than switching immediately,
- mark the run as `handoff` or `checkpoint_pending`.

### 85% Switch Threshold

At or above 85%:

- stop expanding the old context,
- require a final structured checkpoint,
- create a new session through the command-session API,
- seed the new session with checkpoint data,
- continue the same `/autogoal` run automatically.

The threshold should use `ctx.getContextUsage()` when available. If exact ratio is unavailable, use token estimates and conservative fallback thresholds.

## Checkpoint Model

A checkpoint is the canonical handoff unit between sessions.

Suggested JSON shape:

```json
{
  "id": "agc_...",
  "runId": "ag_...",
  "objective": "...",
  "phase": "verify",
  "completed": ["..."],
  "changedFiles": ["src/auth.ts", "src/auth.test.ts"],
  "commandsRun": ["npm test -- auth"],
  "validationStatus": "one test still failing",
  "knownIssues": ["refresh failure branch still needs assertion update"],
  "subagentResults": ["reviewer found no P1 issues"],
  "nextSteps": ["fix assertion", "rerun auth tests"],
  "resumePrompt": "Continue the autogoal run by fixing the remaining auth assertion and rerunning the auth tests."
}
```

Checkpoints should be stored under an extension-owned directory, for example:

```text
~/.pi/agent/autogoal/checkpoints/<checkpoint-id>.json
```

They may also be referenced from workflow run artifacts.

## Session Replacement

The extension should use the safe session replacement API from command context.

Important constraints:

- Tools and normal event handlers should not directly call session replacement if the API only supports it from command handlers.
- If an internal handoff tool detects that a new session is required, it should save a checkpoint and queue an internal continuation step.
- The new session should be seeded with serialized checkpoint data, not stale old context objects.
- The replacement-session callback should use only the fresh context passed to it.

The user-facing behavior remains one command. Internal helper commands, if required, are private plumbing.

## Subagent Policy

Subagents are optional and agent-decided. The default path is a single main agent.

The orchestrator may start subagents when useful:

- `scout`: read-only investigation, broad code search, dependency mapping.
- `reviewer`: independent review of the main diff or plan.
- `verifier`: independent reproduction, test review, or acceptance check.
- `worker`: isolated implementation attempt only when work can be split safely.

### Decision Rules

Use no subagent when:

- the task is small,
- the target files are obvious,
- validation is cheap,
- subagent overhead would exceed expected value.

Use a scout when:

- the codebase area is unknown,
- the task spans multiple components,
- finding the right files is the main risk.

Use a reviewer/verifier when:

- security, auth, migrations, data loss, or persistence behavior is touched,
- the main agent changed core logic,
- tests pass but the risk of self-verification is high,
- the user explicitly asks for review quality.

Use parallel workers only when:

- work can be split into independent shards,
- conflicts are unlikely,
- each worker has a bounded assignment,
- the main agent can synthesize results.

### Isolation

- Read-only scout/reviewer/verifier subagents may run in the main worktree if they do not edit files.
- Editing subagents should use an isolated worktree or return proposed patches instead of directly modifying the main worktree.
- The main agent owns final edits, validation, and completion claims.

## Workflow Run Artifacts

`/autogoal` should optionally create workflow run artifacts compatible with the workflow/loop lifecycle spec.

Suggested path:

```text
~/.pi/agent/workflow-runs/autogoal-<run-id>/
```

Suggested files:

```text
workflow.md
inputs.json
checkpoints/*.json
subagents/*.json
events.jsonl
review.md
summary.md
```

Run artifacts are for audit and later review. They should not be injected into future normal context unless explicitly requested.

## Safety And Permissions

`/autogoal` must respect existing tool permissions and sandboxing.

It must not silently perform external side effects:

- no commits without explicit user request,
- no pushes without explicit user request,
- no GitHub comments without explicit user confirmation,
- no package publish actions,
- no destructive git commands unless explicitly approved,
- no secret persistence in checkpoints or artifacts.

Checkpoint writers must sanitize sensitive values from command outputs, environment snippets, and pasted credentials.

## Observability

The UI should expose concise status when possible:

```text
Autogoal active | ctx 64% | phase verify | review idle
Autogoal handoff pending | ctx 78% | checkpoint required
Autogoal switching | checkpoint agc_... | new session starting
```

The final response should include:

- completion status,
- files changed,
- validation run,
- subagent/review evidence if used,
- residual risks if any.

## Configuration

First version should work without user configuration.

Future optional settings may include:

```json
{
  "autogoal": {
    "prepareThreshold": 0.60,
    "checkpointThreshold": 0.75,
    "switchThreshold": 0.85,
    "maxTurnsPerSession": 12,
    "maxRepairAttempts": 3,
    "maxSubagents": 4,
    "maxParallelSubagents": 2,
    "runArtifacts": true
  }
}
```

No configuration should be required to use `/autogoal <task>`.

## Acceptance Criteria

- A user can start a long task with only `/autogoal <task>`.
- The agent continues autonomously until verified complete, blocked, paused, dropped, or interrupted.
- The loop has budgets, validation signals, and no-progress stop rules.
- Context at 60% prepares but does not switch sessions by default.
- Context at 75% requires a structured checkpoint soon.
- Context at 85% checkpoints and continues in a new session.
- The new session receives enough structured context to continue without the full old conversation.
- Subagents are used only when the orchestrator judges they add value.
- High-risk changes receive independent review or a clear residual-risk note.
- Completion requires current-state evidence, not only self-reporting.
- Workflow run artifacts are optional, audit-oriented, and not auto-promoted.
- Memory, skill, workflow promotion, commits, pushes, and remote comments are not mutated without their own explicit rules or confirmation.
