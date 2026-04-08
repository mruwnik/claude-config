#!/bin/bash
# Stop hook: exit 0 = allow stop, exit 2 = continue (stderr fed to Claude)
# Looks for [INCOMPLETE: ...] token in last assistant message

INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active')

# Prevent infinite loops
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
    exit 0
fi

# Use last_assistant_message from JSON input instead of parsing transcript
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')

if [ -z "$LAST_MSG" ]; then
    exit 0
fi

# Check for INCOMPLETE token in the actual message only
INCOMPLETE=$(echo "$LAST_MSG" | grep -o '\[INCOMPLETE: [^]]*\]' | tail -1)

if [ -n "$INCOMPLETE" ]; then
    REASON=$(echo "$INCOMPLETE" | sed 's/\[INCOMPLETE: \(.*\)\]/\1/')
    echo "Still need to: $REASON" >&2
    exit 2
fi

exit 0
