# Review And Commit Workflow Plan

## Goal

Implement lightweight `/review` and `/commit` workflows that support the common review -> fix -> commit loop with clear, plain-language outputs and explicit user confirmation for external side effects.

Spec: `.pi/docs/specs/review-and-commit-workflow.md`

## Phase 0: Scope And Guardrails

Tasks:

1. Keep the implementation out of core read/tool-discovery changes.
2. Keep all GitHub comments and local commits behind explicit confirmation.
3. Keep outputs plain-language and severity-ranked.
4. Keep the workflows local-first by default.
5. Add no-op tests for disabled or unconfirmed actions.

Acceptance criteria:

- No automatic comment is posted.
- No automatic commit is created.
- Existing memory and skill behavior is unchanged.

## Phase 1: `/review` Template MVP

Tasks:

1. Add a review prompt template or slash-command entry.
2. Support current diff, branch range, and PR target inputs.
3. Standardize output to findings first, verdict last.
4. Require file path and line references for concrete issues when available.
5. Support `--fix`, `--comment`, and `--summary` as lightweight modes.

Tests:

- Current worktree review returns findings and verdict.
- Branch-range review accepts a diff target.
- PR review can produce a plain-language comment draft.
- `--fix` does not run without a review result first.

Acceptance criteria:

- `/review` is useful without any new core read behavior.
- Review results are specific enough to act on immediately.

## Phase 2: Review Fix Loop

Tasks:

1. Add the logic that turns selected review findings into code edits.
2. Apply only confirmed fixes.
3. Keep the repair loop bounded.
4. Run targeted validation after edits.
5. Report remaining risk if some findings stay unresolved.

Tests:

- A selected P1 finding can be fixed.
- Validation runs after the edit.
- Unrelated files remain untouched.

Acceptance criteria:

- The fix loop is bounded, explicit, and safe.
- The workflow can stop after one confirmed repair pass.

## Phase 3: `/commit` Template MVP

Tasks:

1. Add a commit prompt template or slash-command entry.
2. Support status inspection, message drafting, split advice, and PR text drafting.
3. Produce a short commit title plus an explanatory body when useful.
4. Surface mixed-change warnings before any commit action.
5. Keep execution separate from suggestion.

Tests:

- `/commit` returns a useful summary and draft message.
- `/commit split` explains whether the diff should be split.
- `/commit pr` generates a clear PR title/body draft.

Acceptance criteria:

- Commit guidance is useful before any actual commit happens.
- PR text is understandable to a non-author.

## Phase 4: Commit Execution Confirmation

Tasks:

1. Add explicit confirmation flow for staging and committing.
2. Commit only the confirmed scope.
3. Leave unrelated dirty files untouched.
4. Return the created commit hash and message.
5. Never auto-push.

Tests:

- Confirmed commit produces a git commit.
- Unconfirmed commit does nothing.
- Mixed dirty files are called out before execution.

Acceptance criteria:

- The workflow can create commits safely, but only after confirmation.

## Phase 5: GitHub PR Draft Support

Tasks:

1. Generate comment drafts for review findings.
2. Generate PR title/body drafts from the current diff.
3. Add confirmation gates before posting or editing remote text.
4. Prefer one clear summary comment over noisy inline spam for the first version.
5. Preserve drafts if the remote action fails.

Tests:

- Review draft comment is produced before posting.
- PR body draft is understandable and concise.
- Failed remote actions do not discard the draft.

Acceptance criteria:

- Remote-facing text is prepared in plain language and only posted with confirmation.

## Phase 6: Validation And Ergonomics

Tasks:

1. Add examples for local review, PR review, commit message drafting, and PR description drafting.
2. Verify outputs remain concise and actionable.
3. Add regression coverage for no-op and refusal paths.
4. Document what the workflow does not do.

Tests:

- No-op review stays no-op.
- No-op commit stays no-op.
- Refusal paths are stable and user-friendly.

Acceptance criteria:

- The workflow is usable without surprise side effects.
- The docs match the actual behavior.
