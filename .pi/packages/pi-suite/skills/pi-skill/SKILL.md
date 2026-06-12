---
name: pi-skill
description: Reference for this pi agent's installed capabilities, tools, memory system, skills, subagents, web/code search, MCP, and code-intelligence workflows. Use when asked what pi can do, how to use current capabilities, or when changing pi features so this skill stays updated.
---

# Pi Skill

This skill is the local capability index for this pi setup. Use it to answer "what can you do?", choose the right tool/workflow, and keep user-facing capability docs synchronized when features change.

## Maintenance Rule

When adding, removing, renaming, or materially changing any pi capability in this workspace, update this skill in the same change. This includes tools, packages, extensions, memory behavior, skills, subagents, MCP servers, web/search integrations, and code-intelligence workflows.

## Core Coding Tools

- `read`: read text files and images; use this instead of `cat` for file inspection.
- `bash`: run shell commands; prefer `rg`/`rg --files` for search.
- `edit`: precise exact-text replacements in one file.
- `write`: create or overwrite files.
- `lsp_diagnostics` / `lsp_navigation`: primary code-intelligence path for diagnostics, definitions, references, hover, symbols, call hierarchy, rename, and workspace diagnostics.
- `ast_grep_search` / `ast_grep_replace` / `ast_dump`: semantic AST-aware code search and replacement; prefer over raw text search for code patterns.
- `lens_diagnostics`: inspect pi-lens warnings/errors for files touched this session.

## Memory

Installed memory package: `@jhp/pi-memory` from `.pi/packages/pi-memory`.

Memory files live under `~/.pi/agent/memory/`:

- `MEMORY.md`: durable facts, decisions, and preferences.
- `USER.md`: structured user profile and stable preferences.
- `STATE.md`: current dated state, events, temporary facts, and quotas.
- `REVIEW.md`: review queue for stale or merge-candidate memories.
- `SCRATCHPAD.md`: checklist for open items.
- `daily/YYYY-MM-DD.md`: daily append-only logs.
- `.curator-state.json`: last curator run state.
- `audit/curator.jsonl`: curator audit trail.

Memory tools:

- `memory_write`: write long-term, daily, user, state, or review memory. Use `target="state"` with metadata for time-sensitive entries.
- `memory_read`: read long-term, scratchpad, daily, list, user, state, review, or all memory.
- `memory_edit`: read/add/replace/remove/replace_all/compact structured entries in `MEMORY.md`, `USER.md`, `STATE.md`, and `REVIEW.md`.
- `scratchpad`: add/done/undo/clear/list checklist items.
- `memory_search`: qmd-backed keyword, semantic, or deep search across memory files.
- `memory_curate`: manually run curator lifecycle rules.
- `memory_curator_enable`: enable external daily curator service using systemd user timer or cron fallback.
- `memory_curator_disable`: disable and uninstall the external daily curator service.
- `memory_curator_status`: show service backend, schedule, and state.

Structured metadata example:

```md
[type:event status:planned date:2026-06-10]
User plans to watch the NBA Finals.
```

Curator behavior:

- Exact dedupe.
- Event status transitions: `planned -> today -> past`.
- Expired temporary memories go to `REVIEW.md`, not automatic deletion.
- Quotas reset when month/reset rolls over.
- Mutations are audited to `audit/curator.jsonl`.
- External service control lives in `@jhp/pi-memory`: `jhp-pi-memory-curator enable|disable|status|run-once`.
- The external curator service is independent of the pi process. It uses a systemd user timer when available, with cron fallback, so scheduled curation can run even when pi is closed.
- Users can ask pi to enable, disable, or inspect the service via `memory_curator_enable`, `memory_curator_disable`, and `memory_curator_status`.
- Before uninstalling `@jhp/pi-memory`, run `memory_curator_disable` or `jhp-pi-memory-curator disable` so any systemd timer or cron entry is removed.
- `.pi/extensions/memory-curator.ts` is deprecated and only warns users to use `@jhp/pi-memory` service tools.

## Web And Research

- `web_search`: broad web research. Prefer `queries` with 2-4 varied angles for comprehensive research.
- `fetch_content`: fetch readable content from URLs, GitHub repos, YouTube transcripts/video frames, and local videos. For video questions, pass the user's exact question as `prompt`.
- `get_search_content`: retrieve full content saved by `web_search` or `fetch_content`.
- `code_search`: search programming examples, docs, APIs, GitHub, and Stack Overflow; use for library/API/debugging questions before implementation.
- `librarian` skill: use for evidence-backed open-source library internals with exact GitHub source citations.

## Subagents

Use the `pi-subagents` skill and `subagent` tool for delegation.

Typical uses:

- Advisory review of plans or diffs.
- Parallel investigation across multiple files or hypotheses.
- Implementation handoff with structured acceptance criteria.
- Goal-style loops with verification evidence.

Rules:

- Call `subagent` with `action: "list"` before executing agents.
- Use acceptance contracts for broad implementation handoffs.
- Keep one parent agent in control; subagents contribute context, review, or isolated execution.

## MCP

Use `mcp` to discover and call Model Context Protocol servers/tools.

Common flow:

```text
mcp({})                         # status
mcp({ server: "name" })         # list tools
mcp({ search: "query" })        # find tools
mcp({ describe: "tool_name" })  # inspect schema
mcp({ tool: "tool_name", args: "{}" })
```

Do not route built-in pi tools through MCP; call them directly.

## Existing Skills

Local project skills currently include:

- `add-llm-provider`: checklist for adding providers to `packages/ai`.
- `image-to-editable-ppt-slide`: rebuild reference images as editable PowerPoint slides.
- `leetcode-array`: array problem patterns and Python references.
- `weather`: current weather and forecasts using no-key services.
- `pi-skill`: this capability index.

Package-provided skills currently include:

- `librarian`: library internals research with source citations.
- `pi-subagents`: subagent delegation workflows.
- `ast-grep`: AST-aware code search/replace guidance.
- `lsp-navigation`: LSP diagnostics and navigation guidance.
- `write-ast-grep-rule`: author pi-lens ast-grep rules.
- `write-tree-sitter-rule`: author pi-lens tree-sitter rules.

## Pi Package And Extension Notes

Project package configuration is in `.pi/settings.json` and `.pi/npm/package.json`.

Current project packages:

- `@jhp/pi-memory`
- `pi-web-access`
- `pi-mcp-adapter`
- `pi-subagents`
- `pi-lens`

Project extensions are in `.pi/extensions/`. Important current extensions:

- `pet.ts`: terminal pet UI with `/pet` subcommands, argument autocomplete for actions such as `/pet ask`, `/pet position`, and `/pet equip`, plus item drops with pity counters.
- `memory-curator.ts`: deprecated compatibility notice only. The external curator service is managed by `@jhp/pi-memory`.

## Recommended Workflows

- For code changes: inspect files, edit, run targeted tests if tests changed, then run `npm run check` for repo code changes.
- For memory changes: use `memory_write` for new facts and `memory_edit` for updates/removals.
- For time-sensitive memory: write structured `STATE.md` entries with `type`, `status`, and date/reset metadata.
- For web facts or current events: use `web_search`; for page/video details, use `fetch_content`.
- For library internals: use `librarian` or `code_search` with source-backed evidence.
- For broad or risky tasks: use subagents for investigation/review, then integrate deliberately.
