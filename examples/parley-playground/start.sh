#!/usr/bin/env bash
# Starts OpenCode in this folder with its own config, data, state and cache, so the playground
# never touches your real sessions, plugins or the shared background service.
#
#   ./start.sh                     TUI (parley panel)
#   ./start.sh --mini              minimal interface: no parley panel, so rounds fall back or are unavailable
#   ./start.sh --run "message"     one-shot `opencode run`: no panel either
#   --fallback                     parley option fallback: "question" (the built-in question tool when no panel)
#   --no-takeover                  parley option questionTool "off" (default "takeover": question calls become parley cards)
#   --model <provider/model>       model to use (or PARLEY_MODEL)
#
# macOS and Linux (bash). There is no Windows script.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
state="${PARLEY_PLAYGROUND_STATE:-$here/.playground-state}"
model="${PARLEY_MODEL:-amazon-bedrock/global.anthropic.claude-haiku-5-5}"
mode=tui
message=""
fallback="${PARLEY_FALLBACK:-}"
takeover="${PARLEY_QUESTION_TOOL:-takeover}"

while [ $# -gt 0 ]; do
  case "$1" in
    --mini) mode=mini ;;
    --run)
      mode=run
      message="${2:?--run needs a message}"
      shift
      ;;
    --fallback) fallback=question ;;
    --takeover) takeover=takeover ;;
    --no-takeover) takeover=off ;;
    --model)
      model="${2:?--model needs provider/model}"
      shift
      ;;
    -h | --help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $1 (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done

export XDG_CONFIG_HOME="$state/config"
export XDG_DATA_HOME="$state/data"
export XDG_STATE_HOME="$state/state"
export XDG_CACHE_HOME="$state/cache"
# Read by opencode.json through {env:...}.
export PARLEY_FALLBACK="$fallback"
export PARLEY_QUESTION_TOOL="$takeover"
mkdir -p "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"

# The isolated global config holds only the model. Bedrock credentials come from your own
# ~/.aws config through the profile; nothing secret is written here.
provider=""
case "$model" in
  amazon-bedrock/*)
    export AWS_PROFILE="${AWS_PROFILE:-omp-bedrock}"
    provider=$(printf ',\n  "providers": { "amazon-bedrock": { "settings": { "profile": "%s", "region": "%s" } } }' \
      "$AWS_PROFILE" "${AWS_REGION:-us-east-1}")
    ;;
esac
printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "%s"%s\n}\n' "$model" "$provider" \
  > "$XDG_CONFIG_HOME/opencode/opencode.json"

echo "parley playground: model $model, fallback ${fallback:-none}, questionTool $takeover, state $state" >&2
cd "$here"
case "$mode" in
  tui) exec opencode --standalone ;;
  mini) exec opencode mini --standalone ;;
  run) exec opencode run --standalone "$message" ;;
esac
