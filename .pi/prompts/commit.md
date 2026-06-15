---
description: Draft commit messages, split advice, and PR text without side effects
argument-hint: "[message|split|pr|apply] [scope]"
---
Run the `/commit` workflow for: $ARGUMENTS

Scope and guardrails:
- This workflow is only for commit planning, commit message drafting, split advice, PR description drafting, and explicitly confirmed commit execution.
- Do not change core read behavior, do not introduce unified resource reads, and do not use or build tool discovery.
- Default to local-only analysis. Do not create commits, push, or update remote PR text unless I explicitly confirm the exact action after seeing the draft or plan.
- Do not rewrite memory or skills as part of this workflow.
- Never stage unrelated files. Never use `git add .` or `git add -A`.

Default behavior:
1. Inspect `git status --short --branch`.
2. Inspect staged and unstaged diffs for the requested scope.
3. Detect mixed concerns before drafting any final commit plan.
4. Draft commit messages and PR text in plain language.
5. Keep execution separate from suggestions.

Mode handling:
- No mode or `message`: summarize the current changes and draft one commit message. If changes are mixed, warn and suggest split boundaries first.
- `split`: explain whether the diff should be split, group files by intent, and recommend commit order.
- `pr`: draft a PR title and body that answer what changed, why it changed, and how it was validated.
- `apply`: only create a commit after I confirm the exact file scope and commit message. If confirmation is missing or ambiguous, show the proposed plan and stop.

Commit message rules:
- Prefer conventional commit shape when appropriate.
- Keep the title short and specific.
- Use the body only when it adds useful why/context.
- Avoid jargon and AI-flavored prose.
- Avoid embedding large diff summaries.

Commit draft format:
```text
Change Summary
- ...

Split Advice
- ...

Draft Commit Message
fix(scope): concise title

Optional body explaining why the change matters.

Next Step
Reply with the exact files or commit message to apply if you want me to commit.
```

PR draft format:
```md
## What changed

...

## Why

...

## Validation

- ...
```

Split advice rules:
- Call out mixed concerns before any commit action.
- Recommend commit order.
- Group files by intent, not by convenience.
- Do not auto-split unless I explicitly ask.

Confirmed execution rules:
1. Re-read `git status --short` immediately before staging.
2. Stage only the confirmed files or hunks.
3. Commit only the confirmed scope.
4. Return the commit hash and message.
5. Leave unrelated dirty files untouched.
6. Never push unless I explicitly confirm a separate push action.

No-op rules:
- If there are no changes, do not invent a message. Say the worktree has no changes to commit.
- If the requested scope has no diff, say so and stop.
- If mixed dirty files are present outside the confirmed scope, mention that they were left untouched.
