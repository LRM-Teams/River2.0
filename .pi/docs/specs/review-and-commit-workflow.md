# Review And Commit Workflow Spec

## Objective

Define two lightweight workflow commands for day-to-day coding work:

- `/review` for code review, findings, and optional fix-up loops.
- `/commit` for commit planning, commit message drafting, and PR description drafting.

The workflows should improve the common review -> fix -> commit path without changing the core read model, introducing tool discovery, or merging unrelated resource types into a single editing surface.

## Non-Goals

- Do not implement unified `read` for URLs, skills, memory, PRs, or issues in this spec.
- Do not add hidden-tool discovery or BM25-based tool lookup.
- Do not auto-comment on GitHub without explicit user confirmation.
- Do not auto-commit or auto-push without explicit user confirmation.
- Do not rewrite the existing memory/skill lifecycle.

## Design Principles

1. Review first, fix second, commit last.
2. Default to local-only actions until the user asks for an external side effect.
3. Output should be plain language and easy for a non-author to understand.
4. Findings should be prioritized by severity and actionability.
5. Commit advice should separate message drafting from execution.
6. A workflow may suggest a next step, but it must not silently take it.
7. The implementation should live in pi-suite layer docs and commands first, not in core harness code.

## /review Workflow

### Purpose

Turn ad hoc code review into a stable review flow that can inspect local diffs, branch ranges, and PRs, then produce prioritized findings and a verdict.

### Supported Inputs

Examples:

```text
/review
/review current changes
/review main...HEAD
/review PR #12
/review this PR, just give me a draft first
/review current changes and fix P1/P2 after I confirm
```

### Default Behavior

- If no target is provided, review the current worktree diff.
- If a branch range is provided, review that diff.
- If a PR target is provided, inspect PR metadata and diff.
- Findings come first, not summary prose.
- The default output is local-only and non-destructive.
- GitHub comments are only drafted by default, never posted automatically.

### Findings Format

```text
Findings

P1 src/auth.ts:88
Refreshing the token can leave the page stuck in loading when the refresh call fails.
Impact: users can get trapped after session expiry.
Suggestion: surface the failure state and ask the user to log in again.

P2 src/auth.test.ts:45
There is no test for refresh failure.
Impact: future auth changes can regress this path silently.
Suggestion: add a failure-path test for expired sessions.

Verdict
Fix P1 before merging. P2 should be added if the change touches auth.
```

### Severity Meaning

- `P0`: data loss, security, or complete breakage.
- `P1`: clear bug or user-visible regression.
- `P2`: edge case, missing coverage, or maintenance risk.
- `P3`: style, wording, or low-risk improvement.

### Optional Modes

- `--fix`: review first, then repair selected issues, then run relevant checks.
- `--comment`: produce a GitHub comment draft for user approval.
- `--summary`: produce a plain-language review summary for PR description or internal notes.

### Fix Loop Behavior

When the user asks to fix after review:

1. Review the change set.
2. Identify concrete findings.
3. Ask for confirmation if the fix would be broad or risky.
4. Apply the minimum edit needed for the selected findings.
5. Run targeted validation.
6. Report what changed and what remains.

The fix loop should not rewrite unrelated files or chase speculative issues.

### GitHub Comment Behavior

When the user asks for PR comments:

1. Draft the comment in plain language.
2. Show the draft first.
3. Wait for confirmation.
4. Post the comment only after confirmation.

Inline review comments are optional later. The first version may use a single general PR comment.

## /commit Workflow

### Purpose

Turn commit writing into a repeatable workflow that can summarize current changes, suggest split points, and draft PR text in clear language.

### Supported Inputs

Examples:

```text
/commit
/commit message
/commit split
/commit pr
/commit apply
/commit write a PR description in plain language
```

### Default Behavior

- Inspect current git status and diff.
- Detect whether the working tree contains mixed concerns.
- Suggest commit boundaries when the change set is broad.
- Draft commit messages and PR descriptions in plain language.
- Do not commit unless the user explicitly confirms.
- Do not push unless the user explicitly confirms.

### Commit Message Rules

- Prefer conventional commit shape when appropriate.
- Keep the title short and specific.
- Use the body to explain why the change matters.
- Avoid jargon and AI-flavored prose.
- Avoid embedding large diff summaries in the message.

Example:

```text
fix(auth): handle refresh token failure

When refresh fails, the page now exits loading and asks the user to log in again.
```

### PR Description Rules

PR text should answer three questions in plain language:

- What changed?
- Why did it change?
- How was it validated?

Example:

```md
## What changed

This fixes the case where the login page could stay stuck loading after a token refresh failure.

## Why

When a session expired, users could end up with no clear recovery path.

## Validation

- Added a refresh-failure test
- Ran the relevant test suite locally
```

### Split Advice

When the diff mixes unrelated work:

- Call out the mixed concerns.
- Recommend a commit order.
- Group files by intent, not by convenience.
- Do not auto-split unless the user asks for it.

### Execution Behavior

When the user says to apply the plan:

1. Stage or select only the confirmed files.
2. Commit only the confirmed scope.
3. Return the commit hash and message.
4. Leave unrelated dirty files untouched.

## Shared Guardrails

- Never assume a side effect is desired just because it is possible.
- Never comment on GitHub or commit locally without explicit confirmation.
- Never widen the scope silently to include unrelated files.
- Never suppress a mixed-change warning.
- Never rewrite memory or skill files as part of these workflows.
- Never turn review or commit into a hidden background process.

## Suggested User Experience

The intended flow is:

```text
/review current changes
-> findings
-> user asks to fix selected items
-> edits + tests
-> /commit
-> split advice or message draft
-> user confirms
-> commit created
```

For PR work:

```text
/review PR #12
-> findings
-> optional comment draft
-> user confirms
-> post comment
-> /commit pr
-> draft PR title/body
-> user confirms
-> update PR text
```

## Acceptance Criteria

- `/review` can inspect current worktree changes, branch ranges, or PR targets.
- `/review` produces prioritized findings and a verdict.
- `/review --fix` can repair confirmed issues and validate the result.
- `/commit` can draft a commit message and PR description from current changes.
- `/commit split` can explain whether the change set should be split.
- No GitHub comment is posted without confirmation.
- No local commit is created without confirmation.
- The workflows remain useful even without read-tool unification or tool discovery.
