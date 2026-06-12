#!/usr/bin/env bash
set -euo pipefail

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

link_if_safe() {
  local source_path="$1"
  local link_path="$2"
  local label="$3"

  if [ ! -e "$source_path" ]; then
    echo "Skip linking $label: source does not exist: $source_path"
    return 0
  fi

  mkdir -p "$(dirname "$link_path")"
  if [ -L "$link_path" ]; then
    ln -sfn "$source_path" "$link_path"
    echo "Linked $label: $link_path -> $source_path"
  elif [ -d "$link_path" ] && [ -z "$(find "$link_path" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    rmdir "$link_path"
    ln -s "$source_path" "$link_path"
    echo "Linked $label: $link_path -> $source_path"
  elif [ ! -e "$link_path" ]; then
    ln -s "$source_path" "$link_path"
    echo "Linked $label: $link_path -> $source_path"
  else
    echo "Skip linking $label: $link_path exists and is not empty."
  fi
}

WORKSPACE_DIR="${PI_WORKSPACE_DIR:-$PWD}"
WORKSPACE_PI_DIR="$WORKSPACE_DIR/.pi"
MEMORY_DIR="$AGENT_DIR/memory"
EVOLUTION_DIR="${PI_EVOLUTION_DIR:-$AGENT_DIR/evolution}"
EVOLUTION_REMOTE="${PI_EVOLUTION_REMOTE:-}"
LEGACY_SHARED_EVOLUTION_REMOTE="https://github.com/LRM-Teams/pi-evolution.git"
EVOLUTION_BRANCH="${PI_EVOLUTION_BRANCH:-main}"
SUITE_SKILLS_DIR="${PI_SUITE_SKILLS_DIR:-$AGENT_DIR/npm/node_modules/@lebronj/pi-suite/skills}"

mkdir -p "$MEMORY_DIR"
link_if_safe "$MEMORY_DIR" "$WORKSPACE_PI_DIR/memory" "memory"
link_if_safe "$SUITE_SKILLS_DIR" "$WORKSPACE_PI_DIR/skills" "skills"

setup_evolution_repo() {
  if [ "${PI_EVOLUTION_ENABLED:-1}" = "0" ]; then
    echo "Memory evolution versioning disabled by PI_EVOLUTION_ENABLED=0."
    return 0
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo "Skip memory evolution repo setup: git is not installed."
    return 0
  fi
  if [ -e "$EVOLUTION_DIR" ] && [ ! -d "$EVOLUTION_DIR/.git" ]; then
    if [ -z "$(find "$EVOLUTION_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
      rmdir "$EVOLUTION_DIR"
    else
      echo "Skip memory evolution repo setup: $EVOLUTION_DIR exists and is not a git repo."
      return 0
    fi
  fi
  if [ ! -e "$EVOLUTION_DIR" ]; then
    mkdir -p "$(dirname "$EVOLUTION_DIR")"
    if [ -n "$EVOLUTION_REMOTE" ]; then
      if ! git clone --branch "$EVOLUTION_BRANCH" "$EVOLUTION_REMOTE" "$EVOLUTION_DIR"; then
        mkdir -p "$EVOLUTION_DIR"
        git -C "$EVOLUTION_DIR" init -b "$EVOLUTION_BRANCH" 2>/dev/null || git -C "$EVOLUTION_DIR" init
        git -C "$EVOLUTION_DIR" checkout -B "$EVOLUTION_BRANCH" >/dev/null 2>&1 || true
        git -C "$EVOLUTION_DIR" remote add origin "$EVOLUTION_REMOTE" 2>/dev/null || true
      fi
    else
      mkdir -p "$EVOLUTION_DIR"
      git -C "$EVOLUTION_DIR" init -b "$EVOLUTION_BRANCH" 2>/dev/null || git -C "$EVOLUTION_DIR" init
      git -C "$EVOLUTION_DIR" checkout -B "$EVOLUTION_BRANCH" >/dev/null 2>&1 || true
    fi
  elif [ -z "$EVOLUTION_REMOTE" ]; then
    current_remote=$(git -C "$EVOLUTION_DIR" remote get-url origin 2>/dev/null || true)
    if [ "$current_remote" = "$LEGACY_SHARED_EVOLUTION_REMOTE" ]; then
      git -C "$EVOLUTION_DIR" remote remove origin 2>/dev/null || true
    fi
  fi
  mkdir -p "$EVOLUTION_DIR/memory" "$EVOLUTION_DIR/skill-drafts" "$EVOLUTION_DIR/snapshots" "$EVOLUTION_DIR/manifests"
  echo "Memory evolution repo ready: $EVOLUTION_DIR"
  if [ -n "$EVOLUTION_REMOTE" ]; then
    echo "Remote: $EVOLUTION_REMOTE"
    echo "Auto push remains off by default. Use /memory-version-push or PI_EVOLUTION_AUTO_PUSH=1."
  else
    echo "Remote: none (local-only by default). Set PI_EVOLUTION_REMOTE to a personal private repo if you want backup sync."
  fi
}

setup_evolution_repo

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
