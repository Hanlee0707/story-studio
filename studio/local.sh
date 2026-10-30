#!/usr/bin/env bash
# Run the Story Studio maker from Han's Mac: once, or as a loop that sweeps every 10 s.
# Keys come from ~/.config (never printed). Usage: studio/local.sh [--loop]
set -euo pipefail
cd "$(dirname "$0")"
export SPROUT_TOKEN="$(cat ~/.config/sprout/story-studio-stage-token)"
export GEMINI_API_KEY="$(tr -d '\n ' < ~/.config/sprout/gemini-social-factory.key)"
export FAL_KEY="$(tr -d '\n ' < ~/.config/sprout/fal-api-key)"
export ANTHROPIC_API_KEY="$(grep '^ANTHROPIC_API_KEY=' ~/.config/founders/.env | head -1 | cut -d= -f2- | tr -d '"')"
export CANVAS_ID="${CANVAS_ID:-e9adadc9-27f9-43bf-8039-83daa23118ed}"
export STUDIO_KIDS="${STUDIO_KIDS:-019fec86-09d1-7474-9196-01b3fdc70da7}"
if [[ "${1:-}" == "--loop" ]]; then
  echo "sweeping every 10 s for kids: $STUDIO_KIDS (ctrl-c to stop)"
  while true; do node make.mjs --sweep || true; sleep 10; done
else
  node make.mjs --sweep
fi
