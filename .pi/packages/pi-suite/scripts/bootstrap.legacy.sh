#!/usr/bin/env bash
set -euo pipefail

# Leftover from main: old team OpenAI-compatible endpoint.
# Default install is DeepSeek. Only used when TEAM_PROFILE=legacy.

TEAM_BASE_URL="${TEAM_BASE_URL:-https://claude-code.club/openai/v1}"
TEAM_MODEL="${TEAM_MODEL:-gpt-5.5}"
PI_SUITE="${PI_SUITE:-npm:@lebronj/pi-suite}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js first." >&2
  exit 1
fi

prompt_secret() {
  local prompt="$1"
  local var_name="$2"
  local value=""
  local stty_state=""

  if [ ! -t 0 ] && [ ! -r /dev/tty ]; then
    echo "$prompt is required. Re-run from a terminal or set $var_name in the environment." >&2
    return 1
  fi

  printf "%s: " "$prompt" >/dev/tty
  if command -v stty >/dev/null 2>&1; then
    stty_state=$(stty -g </dev/tty 2>/dev/null || true)
    stty -echo </dev/tty 2>/dev/null || true
  fi
  IFS= read -r value </dev/tty
  if [ -n "$stty_state" ]; then
    stty "$stty_state" </dev/tty 2>/dev/null || true
  fi
  printf "\n" >/dev/tty

  if [ -z "$value" ]; then
    echo "$prompt is required." >&2
    return 1
  fi

  printf -v "$var_name" '%s' "$value"
}

TEAM_API_KEY="${TEAM_API_KEY:-}"
if [ -z "$TEAM_API_KEY" ]; then
  prompt_secret "OpenAI-compatible API key" TEAM_API_KEY
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
fs.writeFileSync(path, `${JSON.stringify({
  ...current,
  defaultProvider: "openai",
  defaultModel: process.env.TEAM_MODEL,
  theme: current.theme ?? "light",
}, null, 2)}\n`);
NODE

echo "Installing Pi extension suite: $PI_SUITE"
pi install "$PI_SUITE"
pi install npm:pi-web-access

echo "Legacy profile done. Provider: openai  Base URL: $TEAM_BASE_URL  Model: $TEAM_MODEL"
