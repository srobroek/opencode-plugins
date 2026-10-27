#!/usr/bin/env bash
# Deletes the playground's isolated OpenCode config, sessions, state and cache.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
state="${PARLEY_PLAYGROUND_STATE:-$here/.playground-state}"
rm -rf "$state"
echo "removed $state"
