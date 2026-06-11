#!/usr/bin/env bash
set -euo pipefail

TEAM_BASE_URL="${TEAM_BASE_URL:-https://claude-code.club/openai/v1}"
TEAM_MODEL="${TEAM_MODEL:-gpt-5.5}"
PI_SUITE="${PI_SUITE:-npm:@lebronj/pi-suite}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js first." >&2
  exit 1
fi

printf "OpenAI-compatible API key: " >&2
stty_state=""
if command -v stty >/dev/null 2>&1; then
  stty_state=$(stty -g 2>/dev/null || true)
  stty -echo 2>/dev/null || true
fi
IFS= read -r TEAM_API_KEY
if [ -n "$stty_state" ]; then
  stty "$stty_state" 2>/dev/null || true
fi
printf "\n" >&2

if [ -z "$TEAM_API_KEY" ]; then
  echo "API key is required." >&2
  exit 1
fi

echo "Installing Pi CLI..."
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

AGENT_DIR="$HOME/.pi/agent"
mkdir -p "$AGENT_DIR"

MODELS_FILE="$AGENT_DIR/models.json"
SETTINGS_FILE="$AGENT_DIR/settings.json"

MODELS_FILE="$MODELS_FILE" TEAM_BASE_URL="$TEAM_BASE_URL" TEAM_API_KEY="$TEAM_API_KEY" node <<'NODE'
const fs = require("node:fs");
const path = process.env.MODELS_FILE;
const current = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
const providers = current.providers && typeof current.providers === "object" ? current.providers : {};
providers.openai = {
  ...(providers.openai && typeof providers.openai === "object" ? providers.openai : {}),
  baseUrl: process.env.TEAM_BASE_URL,
  apiKey: process.env.TEAM_API_KEY,
};
fs.writeFileSync(path, `${JSON.stringify({ ...current, providers }, null, 2)}\n`);
NODE

SETTINGS_FILE="$SETTINGS_FILE" TEAM_MODEL="$TEAM_MODEL" node <<'NODE'
const fs = require("node:fs");
const path = process.env.SETTINGS_FILE;
const current = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
const next = {
  ...current,
  defaultProvider: "openai",
  defaultModel: process.env.TEAM_MODEL,
  theme: current.theme ?? "light",
};
fs.writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
NODE

echo "Installing Pi extension suite: $PI_SUITE"
pi install "$PI_SUITE"

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to auto-install Bun for qmd." >&2
    return 1
  fi

  echo "Installing Bun for qmd..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  command -v bun >/dev/null 2>&1
}

echo "Setting up qmd for memory_search..."
if ensure_bun; then
  bun install -g https://github.com/tobi/qmd
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  mkdir -p "$HOME/.pi/agent/memory"
  if command -v qmd >/dev/null 2>&1; then
    qmd collection add "$HOME/.pi/agent/memory" --name pi-memory || true
    qmd embed || echo "qmd embed failed; run 'qmd embed' later to enable semantic memory_search."
  else
    echo "qmd was installed but is not on PATH. Add ~/.bun/bin to PATH, then run qmd embed."
  fi
else
  cat <<'MSG'
Could not auto-install Bun, so qmd setup was skipped.
Core memory tools still work, but memory_search needs qmd.
Install later with:
  curl -fsSL https://bun.sh/install | bash
  bun install -g https://github.com/tobi/qmd
  qmd collection add ~/.pi/agent/memory --name pi-memory
  qmd embed
MSG
fi

cat <<MSG
Done.
Provider: openai
Base URL: $TEAM_BASE_URL
Model: $TEAM_MODEL
Run: pi
MSG
