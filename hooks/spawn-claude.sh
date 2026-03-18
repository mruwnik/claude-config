#!/bin/bash
# Spawn a remote Claude session
# Usage: spawn-claude.sh <api_key> <prompt> [environment_id]

set -euo pipefail

API_KEY="$1"
PROMPT="$2"
ENV_ID="${3:-8}"

curl "https://memory.equistamp.io/claude/spawn" \
  -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg prompt "$PROMPT" \
    --argjson env_id "$ENV_ID" \
    '{
      environment_id: $env_id,
      initial_prompt: $prompt,
      allowed_tools: ["WebFetch", "WebSearch", "Task", "Edit", "NotebookEdit", "Bash", "Read", "Write", "Glob", "Grep", "MCPSearch"]
    }'
  )"
