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
curl -fsSL https://registry.npmjs.org/@lebronj/pi-suite/-/pi-suite-0.1.2.tgz | tar -xzO package/scripts/bootstrap.sh | bash
```

## What Is Included

- Local extensions: goal mode, pet, prompt URL widget, TUI redraw stats, snake, TPS notifications.
- Prompts: changelog audit, issue analysis, PR review, wrap workflow.
- Skills: provider checklist, weather, LeetCode array practice, Pi capability reference, image-to-editable-PPT workflow.
- Vendored package: `@jhp/pi-memory`.

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

The bootstrap script asks for an API key and writes:

- Provider: OpenAI-compatible `openai`
- Base URL: `https://claude-code.club/openai/v1`
- Default model: `gpt-5.5`

The API key is written to `~/.pi/agent/models.json` on the user's machine. Do not publish a shared key in this package.

## Memory Search

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
