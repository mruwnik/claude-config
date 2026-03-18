#!/bin/bash
# Stop hook: exit 0 = allow stop, exit 2 = continue (stderr fed to Claude)
# Looks for [INCOMPLETE: ...] token in last message

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path')
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active')

# Prevent infinite loops
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
    exit 0
fi

# Check last few lines for INCOMPLETE token
INCOMPLETE=$(tail -20 "$TRANSCRIPT_PATH" 2>/dev/null | grep -o '\[INCOMPLETE: [^]]*\]' | tail -1)

if [ -n "$INCOMPLETE" ]; then
    # Extract the reason from the token
    REASON=$(echo "$INCOMPLETE" | sed 's/\[INCOMPLETE: \(.*\)\]/\1/')
    echo "Still need to: $REASON" >&2
    exit 2
fi

exit 0
