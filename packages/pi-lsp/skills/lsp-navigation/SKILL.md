---
name: lsp-navigation
description: Use pi-lsp code intelligence for diagnostics, definitions, references, hover, symbols, call-aware navigation, rename, code actions, and workspace diagnostics.
---

# LSP Navigation

Use this skill when code understanding or refactoring requires language-server accuracy.

## Rules

- Prefer `lsp` over raw text search for symbol-aware operations when a language server is configured.
- Use `lsp` `rename` for cross-file symbol renames; do not use text replacement when LSP rename works.
- Use `lsp` `references`, `definition`, `type_definition`, or `implementation` before editing code whose ownership or call sites are unclear.
- Use `lsp` `diagnostics` after edits to files covered by an available language server.
- Use `lsp` `code_actions` for quick fixes, organize imports, and refactors offered by the language server.

## Common Calls

- `status`: check configured and active language servers.
- `diagnostics` with `file: "*"`: workspace diagnostics.
- `diagnostics` with a file or glob: targeted diagnostics.
- `definition` / `references`: pass `file`, 1-indexed `line`, and `symbol`.
- `symbols` with `file`: document outline.
- `symbols` with `file: "*"` and `query`: workspace symbol search.
- `rename` with `file`, `line`, `symbol`, `new_name`, and optional `apply: false` preview.
- `rename_file` with `file`, `new_name`, and optional `apply: false` preview.
