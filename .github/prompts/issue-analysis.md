Analyze GitHub issue(s): $ARGUMENTS

For each issue:

1. When running under CI, do not add the `inprogress` label and do not assign the issue.
2. Read the issue in full, including all comments and linked issues/PRs. Use fields supported by GitHub CLI, for example:
   ```sh
   gh issue view <issue> --json title,body,comments,labels,assignees,state,url,author,createdAt,updatedAt,closedByPullRequestsReferences
   ```
3. Do not trust analysis written in the issue. Independently verify behavior and derive your own analysis from the code and execution path.
4. For bugs:
   - Ignore root cause analysis in the issue.
   - Read all related code files in full.
   - Trace the code path, identify the actual root cause, and propose a fix.
5. For feature requests:
   - Do not trust implementation proposals in the issue without verification.
   - Read all related code files in full.
   - Propose the most concise implementation approach and list affected files.

Do not implement unless explicitly asked. Analyze and propose only.
