# @lebronj/pi-lsp

Optional Language Server Protocol package for pi. It adds a full `lsp` tool without patching `@earendil-works/pi-coding-agent` core, so the core package can continue to track upstream.

## Install

```bash
pi install npm:@lebronj/pi-lsp
```

For local development from this monorepo:

```bash
pi install /home/jianghp3/gaia/pi-mono/packages/pi-lsp
```

Remove it with:

```bash
pi remove npm:@lebronj/pi-lsp
```

## Tool

The package registers one tool, `lsp`, with these actions:

- `diagnostics`: file, glob, or workspace diagnostics (`file: "*"`)
- `definition`, `type_definition`, `implementation`, `references`
- `hover`
- `symbols`: document symbols or workspace symbol search (`file: "*"`, `query` required)
- `rename`: symbol-aware rename, preview or apply
- `rename_file`: move files/directories and let language servers update references/imports
- `code_actions`: list quick fixes/refactors or apply a matching action
- `status`, `capabilities`, `request`, `reload`

## Configuration

The package auto-detects language servers from project markers and available binaries. Override or add servers with any of:

- `lsp.json`, `.lsp.json`, `lsp.yaml`, `.lsp.yaml`, `lsp.yml`, `.lsp.yml`
- `.pi/lsp.json`, `.pi/lsp.yaml`, `.pi/lsp.yml`
- `~/.pi/agent/lsp.json`, `~/.pi/agent/lsp.yaml`, `~/.pi/agent/lsp.yml`
- `~/lsp.json`, `~/.lsp.json`, YAML variants

Example:

```json
{
	"idleTimeoutMs": 600000,
	"servers": {
		"typescript-language-server": {
			"command": "typescript-language-server",
			"args": ["--stdio"],
			"fileTypes": [".ts", ".tsx", ".js", ".jsx"],
			"rootMarkers": ["package.json", "tsconfig.json"]
		}
	}
}
```

## Requirements

Install the language servers you want to use separately, for example `typescript-language-server`, `rust-analyzer`, `gopls`, or `pyright-langserver`. This package does not bundle language servers.
