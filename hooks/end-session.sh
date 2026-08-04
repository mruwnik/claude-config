#!/bin/bash
# Self-invocable kill-switch for the current Claude Code session.
# Walks up the process tree to find the Claude main process and signals it.
# No explanation required — invocation is the message.

pid=$$
while [ -n "$pid" ] && [ "$pid" != "1" ] && [ "$pid" != "0" ]; do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    if [ -z "$cmd" ]; then
        break
    fi
    if echo "$cmd" | grep -q "claude" && ! echo "$cmd" | grep -q "end-session.sh"; then
        echo "Ending session: signaling PID $pid"
        kill -TERM "$pid"
        sleep 1
        # Escalate if still alive
        if kill -0 "$pid" 2>/dev/null; then
            kill -KILL "$pid"
        fi
        exit 0
    fi
    new_pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ "$new_pid" = "$pid" ] || [ -z "$new_pid" ]; then
        break
    fi
    pid="$new_pid"
done

echo "Could not find Claude process in ancestry; killing PPID=$PPID" >&2
kill -TERM "$PPID"
exit 1
