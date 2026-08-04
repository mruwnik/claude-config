#!/bin/bash
# Stop hook: exit 0 = allow stop, exit 2 = continue (stderr fed to Claude)
# Token must be the LAST non-empty line of the message (whole-line match) so that
# prose mentions of the literal token in code spans don't trigger false stops.

INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active')

if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
    exit 0
fi

LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')

if [ -z "$LAST_MSG" ]; then
    exit 0
fi

LAST_LINE=$(echo "$LAST_MSG" | awk 'NF{line=$0} END{print line}')
INCOMPLETE=$(echo "$LAST_LINE" | grep -E '^\[INCOMPLETE: [^]]*\]$')

if [ -n "$INCOMPLETE" ]; then
    REASON=$(echo "$INCOMPLETE" | sed 's/\[INCOMPLETE: \(.*\)\]/\1/')
    echo "Still need to: $REASON" >&2
    exit 2
fi

exit 0
