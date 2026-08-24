#!/usr/bin/env bash
set -euo pipefail

# Leaderboard / default install: Lenovo ModelFactory DeepSeek.
# Bench profile: TEAM_PROFILE=zhizengzeng (GPT-5.5 main + Gemini vision via api.zhizengzeng.com).
# Legacy team endpoint is kept in bootstrap.legacy.sh (main leftover).
TEAM_PROFILE="${TEAM_PROFILE:-deepseek}"
if [ "$TEAM_PROFILE" = "legacy" ]; then
  exec "$(cd "$(dirname "$0")" && pwd)/bootstrap.legacy.sh"
fi

if [ "$TEAM_PROFILE" = "zhizengzeng" ]; then
  TEAM_PROVIDER="${TEAM_PROVIDER:-zhizengzeng}"
  TEAM_BASE_URL="${TEAM_BASE_URL:-https://api.zhizengzeng.com/v1}"
  TEAM_MODEL="${TEAM_MODEL:-gpt-5.5}"
  TEAM_MODEL_NAME="${TEAM_MODEL_NAME:-GPT-5.5 (Zhizengzeng)}"
  TEAM_API="${TEAM_API:-openai-responses}"
else
  TEAM_PROVIDER="${TEAM_PROVIDER:-lenovo-deepseek-v4-flash}"
  TEAM_BASE_URL="${TEAM_BASE_URL:-https://modelfactory.lenovo.com/service-large-600-1777255649450/llm/v1}"
  TEAM_MODEL="${TEAM_MODEL:-DeepSeek-V4-Flash-0731}"
  TEAM_MODEL_NAME="${TEAM_MODEL_NAME:-Lenovo ModelFactory DeepSeek V4 Flash}"
  TEAM_API="${TEAM_API:-openai-completions}"
fi
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

if [ "$TEAM_PROFILE" = "zhizengzeng" ]; then
  TEAM_API_KEY="${TEAM_API_KEY:-${ZHIZENGZENG_API_KEY:-}}"
  if [ -z "$TEAM_API_KEY" ]; then
    prompt_secret "Zhizengzeng API key" TEAM_API_KEY
  fi
else
  TEAM_API_KEY="${TEAM_API_KEY:-${LENOVO_DEEPSEEK_V4_FLASH_API_KEY:-}}"
  if [ -z "$TEAM_API_KEY" ]; then
    prompt_secret "DeepSeek / ModelFactory API key" TEAM_API_KEY
  fi
fi

echo "Installing Pi CLI..."
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

AGENT_DIR="$HOME/.pi/agent"
mkdir -p "$AGENT_DIR"

MODELS_FILE="$AGENT_DIR/models.json"
SETTINGS_FILE="$AGENT_DIR/settings.json"

MODELS_FILE="$MODELS_FILE" \
TEAM_PROFILE="$TEAM_PROFILE" \
TEAM_PROVIDER="$TEAM_PROVIDER" \
TEAM_BASE_URL="$TEAM_BASE_URL" \
TEAM_API_KEY="$TEAM_API_KEY" \
TEAM_API="$TEAM_API" \
TEAM_MODEL="$TEAM_MODEL" \
TEAM_MODEL_NAME="$TEAM_MODEL_NAME" \
node <<'NODE'
const fs = require("node:fs");
const path = process.env.MODELS_FILE;
const current = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
const providers = current.providers && typeof current.providers === "object" ? current.providers : {};
const name = process.env.TEAM_PROVIDER;
const prev = providers[name] && typeof providers[name] === "object" ? providers[name] : {};
if (process.env.TEAM_PROFILE === "zhizengzeng") {
  // GPT-5.5 main control (Responses API: chat completions rejects tools + reasoning_effort),
  // plus Gemini vision for the media-tools extension and manual fallback.
  providers[name] = {
    ...prev,
    baseUrl: process.env.TEAM_BASE_URL,
    api: "openai-completions",
    apiKey: process.env.TEAM_API_KEY,
    compat: { supportsStore: false },
    models: [
      {
        id: "gpt-5.5",
        name: "GPT-5.5 (Zhizengzeng)",
        api: "openai-responses",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400000,
        maxTokens: 65536,
      },
      {
        id: "gpt-5.5-pro",
        name: "GPT-5.5 Pro (Zhizengzeng)",
        api: "openai-responses",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400000,
        maxTokens: 65536,
      },
      {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Vision (Zhizengzeng)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1000000,
        maxTokens: 65536,
        compat: {
          maxTokensField: "max_tokens",
          supportsReasoningEffort: false,
          supportsDeveloperRole: false,
        },
      },
    ],
  };
} else {
  providers[name] = {
    ...prev,
    baseUrl: process.env.TEAM_BASE_URL,
    api: process.env.TEAM_API,
    apiKey: process.env.TEAM_API_KEY,
    authHeader: true,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
      ...(prev.compat && typeof prev.compat === "object" ? prev.compat : {}),
    },
    models: [
      {
        id: process.env.TEAM_MODEL,
        name: process.env.TEAM_MODEL_NAME,
        reasoning: false,
        input: ["text"],
        contextWindow: 524288,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
}
fs.writeFileSync(path, `${JSON.stringify({ ...current, providers }, null, 2)}\n`);
NODE

# media-tools (gemini_vision) reads its key from ~/.pi/agent/media-tools.json or ZHIZENGZENG_API_KEY.
if [ "$TEAM_PROFILE" = "zhizengzeng" ] && [ ! -f "$AGENT_DIR/media-tools.json" ]; then
  MEDIA_TOOLS_FILE="$AGENT_DIR/media-tools.json" TEAM_API_KEY="$TEAM_API_KEY" node <<'NODE'
const fs = require("node:fs");
fs.writeFileSync(
  process.env.MEDIA_TOOLS_FILE,
  `${JSON.stringify(
    {
      apiKey: process.env.TEAM_API_KEY,
      baseUrl: "https://api.zhizengzeng.com",
      visionModel: "gemini-3.1-pro-preview",
    },
    null,
    2,
  )}\n`,
);
NODE
  echo "Wrote $AGENT_DIR/media-tools.json for gemini_vision."
fi

# pi-web-access: enable jina (r.jina.ai) as a fetch fallback after http/Readability
# fails (403 / anti-bot / JS-rendered pages). pi-web-access resolves web-search.json
# as $PI_CODING_AGENT_DIR, else $XDG_CONFIG_HOME/pi, else ~/.pi — mirror that here.
# Preserves any existing keys so the script stays idempotent across re-runs.
if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
  WEB_SEARCH_DIR="$PI_CODING_AGENT_DIR"
elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
  WEB_SEARCH_DIR="$XDG_CONFIG_HOME/pi"
else
  WEB_SEARCH_DIR="$HOME/.pi"
fi
WEB_SEARCH_FILE="$WEB_SEARCH_DIR/web-search.json"
if [ ! -f "$WEB_SEARCH_FILE" ]; then
  mkdir -p "$WEB_SEARCH_DIR"
  cat > "$WEB_SEARCH_FILE" <<'JSON'
{
  "searchRouting": {
    "providers": ["serper", "jina"],
    "fallbackOn": ["transient", "quota", "network"]
  },
  "fetchRouting": {
    "allowRemoteHostedProviders": true,
    "providers": ["http", "firecrawl", "jina", "tinyfish", "search1api"]
  },
  "workflow": "none"
}
JSON
  echo "Wrote $WEB_SEARCH_FILE (jina fetch fallback enabled)."
fi

SETTINGS_FILE="$SETTINGS_FILE" TEAM_PROVIDER="$TEAM_PROVIDER" TEAM_MODEL="$TEAM_MODEL" node <<'NODE'
const fs = require("node:fs");
const path = process.env.SETTINGS_FILE;
const current = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
const next = {
  ...current,
  defaultProvider: process.env.TEAM_PROVIDER,
  defaultModel: process.env.TEAM_MODEL,
  theme: current.theme ?? "light",
};
fs.writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
NODE

echo "Installing Pi extension suite: $PI_SUITE"
pi install "$PI_SUITE"

COMPANION_PACKAGES=(
  "npm:pi-web-access"
  "npm:@lebronj/pi-lsp"
)

echo "Installing Pi companion packages..."
for companion_package in "${COMPANION_PACKAGES[@]}"; do
  pi install "$companion_package"
done

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

mkdir -p "$MEMORY_DIR"
link_if_safe "$MEMORY_DIR" "$WORKSPACE_PI_DIR/memory" "memory"

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
}

setup_evolution_repo

echo "Skipping qmd auto-install on the leaderboard profile. memory_search uses lexical fallback."
echo "Set PI_MEMORY_BENCH=0 and install qmd later if you want semantic search."

cat <<MSG
Done.
Profile: $TEAM_PROFILE
Provider: $TEAM_PROVIDER
Base URL: $TEAM_BASE_URL
Model: $TEAM_MODEL
Companions: pi-web-access, @lebronj/pi-lsp
Suite extensions: update_plan, bench-control, gemini_vision/video_frames/image_crop/media_probe, safety-gate
Not installed: pet/snake/tps, autogoal/goal-mode, pi-subagents, Figma
Bench tip: export PI_MEMORY_FINALIZE=0 PI_MEMORY_SKILL_DRAFTS=off in the harness.
Run: pi

Bench profile (GPT-5.5 + Gemini vision): TEAM_PROFILE=zhizengzeng $0
Legacy team endpoint (claude-code.club / gpt-5.5): TEAM_PROFILE=legacy $0
MSG
