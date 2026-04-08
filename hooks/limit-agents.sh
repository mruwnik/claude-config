#!/bin/bash
# PreToolUse hook that limits subagent spawning based on available memory.
# Each claude subagent uses ~0.5-1 GB of RSS. We block new spawns when
# available memory drops below the reserve threshold.

set -e

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
[[ "$TOOL_NAME" == "Agent" ]] || exit 0

# Minimum available memory required to allow a new agent (in MB).
# Default 1500 MB = ~1 GB for the new agent + 500 MB headroom.
RESERVE_MB="${CLAUDE_AGENT_RESERVE_MB:-1500}"

# Hard ceiling on pane count regardless of memory (safety net).
MAX_PANES="${CLAUDE_MAX_PANES:-15}"

# Read container's memory limit from cgroup v2 (not host /proc/meminfo,
# which shows the whole machine's stats, not the container's).
CGROUP_MAX=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo max)
CGROUP_CUR=$(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0)

if [[ "$CGROUP_MAX" == "max" ]]; then
    # Unlimited container — fall back to host available memory
    AVAILABLE_MB=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
else
    AVAILABLE_MB=$(( (CGROUP_MAX - CGROUP_CUR) / 1024 / 1024 ))
fi

PANES=$(tmux list-panes -t claude -a 2>/dev/null | wc -l || echo 0)

block() {
    local reason="$1"
    jq -n --arg reason "$reason" '{
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: $reason
        }
    }'
    exit 0
}

if (( PANES >= MAX_PANES )); then
    block "Cannot spawn agent: hard cap of $MAX_PANES panes reached ($PANES currently open)."
fi

if (( AVAILABLE_MB < RESERVE_MB )); then
    block "Cannot spawn agent: only ${AVAILABLE_MB}MB available, need ${RESERVE_MB}MB free (each agent uses ~1GB). $PANES panes currently open. Wait for agents to finish."
fi

exit 0
