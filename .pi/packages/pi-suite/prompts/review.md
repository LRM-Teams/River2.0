---
description: Review local changes, branch ranges, or PRs with prioritized findings
argument-hint: "[target] [--fix] [--comment] [--summary]"
---
Run the `/review` workflow for: $ARGUMENTS

Scope and guardrails:
- This workflow is only for code review and the optional bounded fix/comment/summary modes described here.
- Do not change core read behavior, do not introduce unified resource reads, and do not use or build tool discovery.
- Default to local-only analysis. Do not post GitHub comments unless I explicitly confirm after seeing the draft.
- Do not commit, push, rewrite memory, or rewrite skills as part of this workflow.
- Do not switch branches or check out PR branches unless I explicitly ask.

Target resolution:
- If no target is provided, review the current worktree diff, including staged and unstaged changes.
- If a git range is provided, review that range with `git diff <range>` and related files as needed.
- If a PR number or URL is provided, inspect PR metadata and diff with `gh pr view`, `gh pr diff`, `gh api`, or fetched refs without changing branches.
- If the target is ambiguous, ask one concise clarifying question before reviewing.

Review process:
1. Inspect `git status` before local review so unrelated dirty files are visible.
2. Read the relevant diff first, then read full related files when needed to validate behavior.
3. Focus on concrete bugs, user-visible regressions, security/data-loss risks, missing validation, and meaningful test gaps.
4. Prioritize findings by severity and actionability. Do not pad with style nits.
5. If no findings are found, state that explicitly and mention residual risks or unrun checks.

Severity meanings:
- P0: data loss, security issue, or complete breakage.
- P1: clear bug or user-visible regression.
- P2: edge case, missing coverage, or maintenance risk.
- P3: style, wording, or low-risk improvement.

Output format:
```text
Findings

P1 path/to/file.ts:88
Problem statement in one sentence.
Impact: why this matters.
Suggestion: the smallest useful fix.

P2 path/to/test.ts:45
Problem statement in one sentence.
Impact: why this matters.
Suggestion: the smallest useful fix.

Verdict
Fix P1 before merging. P2 should be addressed if this area is changing.
```

Formatting rules:
- Findings come first. Keep summary prose after findings, not before.
- Include file paths and line numbers for concrete issues when available.
- Use plain language a non-author can understand.
- Keep the verdict short and specific.

Mode handling:
- `--summary`: add a concise review summary after the verdict.
- `--comment`: draft one general GitHub PR comment after the verdict, show it locally, and wait for my confirmation before posting.
- `--fix`: review first. If I did not already name the exact findings or severities to fix, stop after the review and ask which findings to repair. If I did name them, apply only those confirmed fixes, run targeted validation, then report what changed and what risk remains.

Fix loop constraints:
- Keep fixes minimal and bounded to the selected findings.
- Do not rewrite unrelated files.
- Do not chase speculative issues.
- Run targeted validation after edits when a relevant local check exists.
- If a fix is broad or risky, ask for confirmation before editing even when `--fix` is present.
