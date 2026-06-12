# @lebronj/pi-suite

JHP's Pi extension suite for team coding workflows.

## Install

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install npm:@lebronj/pi-suite
pi install npm:pi-web-access
pi install npm:pi-mcp-adapter
pi install npm:pi-subagents
```

Or use the bootstrap script to install Pi, configure the team OpenAI-compatible endpoint, install this suite, and set up Bun + qmd for memory search:

```bash
curl -fsSL https://registry.npmjs.org/@lebronj/pi-suite/-/pi-suite-0.1.8.tgz | tar -xzO package/scripts/bootstrap.sh | bash
```

## What Is Included

- Local extensions: goal mode, pet, prompt URL widget, TUI redraw stats, snake, TPS notifications.
- Prompts: changelog audit, issue analysis, PR review, wrap workflow.
- Skills: provider checklist, weather, LeetCode array practice, Pi capability reference, image-to-editable-PPT workflow.
- Vendored package: `@jhp/pi-memory`, including qmd search, external curator service, and memory/skill-draft versioning.

Install optional packages separately if needed:

```bash
pi install npm:pi-web-access
pi install npm:pi-mcp-adapter
pi install npm:pi-subagents
```

Debug-only extensions are intentionally excluded:

- `dump-system-prompt.ts`
- `zz-full-session-log.ts`
- `agentmemory`

## Team Model Setup

The bootstrap script can be run with `curl | bash`: it reads the API key from the terminal instead of stdin. It asks for an API key and writes:

- Provider: OpenAI-compatible `openai`
- Base URL: `https://claude-code.club/openai/v1`
- Default model: `gpt-5.5`

The API key is written to `~/.pi/agent/models.json` on the user's machine. Do not publish a shared key in this package.

## Memory And Versioning

`@jhp/pi-memory` works without qmd for core memory features:

- `memory_write`
- `memory_read`
- `memory_edit`
- `scratchpad`
- `memory_curate`

`memory_search` needs qmd. The bootstrap script installs and initializes qmd when Bun is available. If Bun is missing, install qmd later:

```bash
bun install -g https://github.com/tobi/qmd
qmd collection add ~/.pi/agent/memory --name pi-memory
qmd embed
```

Memory versioning is enabled by default. It snapshots `~/.pi/agent/memory` and `~/.pi/agent/skill-drafts` into `~/.pi/agent/evolution`, commits local changes automatically, and leaves push manual by default. `memory_curate` also scans yesterday's daily log into `REVIEW.md` when learning is enabled and the daily file changed since the last scan.

Useful commands:

```bash
/memory-version-status
/memory-version-snapshot optional reason
/memory-version-list
/memory-version-restore <snapshot-id> [memory|skill-drafts|all]
/memory-version-push
```

Memory evolution is local-only by default and does not configure a shared remote. If a user wants backup sync, set `PI_EVOLUTION_REMOTE` to their own private repo before bootstrap/setup, or add a personal remote later with `git -C ~/.pi/agent/evolution remote add origin <url>`. Set `PI_EVOLUTION_AUTO_PUSH=1` only if automatic remote sync is desired.

## Goal Mode

Use `/goal <objective>` to keep Pi working on one task until it is verified complete. Goal mode injects hidden task context, enables a `goal` tool for completion/drop/resume, and auto-continues between turns instead of stopping at a minimal implementation.

Useful commands:

```bash
/goal <objective>
/goal show
/goal pause
/goal resume
/goal drop
/goal auto on
/goal auto off
```

## Update

```bash
pi update
```

Only update Pi itself:

```bash
pi update --self
```

Only update installed Pi packages:

```bash
pi update --extensions
```
