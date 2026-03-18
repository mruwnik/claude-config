#!/bin/bash
# Show a macOS notification when Claude finishes or needs approval,
# if the terminal tab isn't active.
# Works at the TAB level via TTY comparison.
# Used by both Stop and PermissionRequest hooks.

INPUT=$(cat)

# --- Tab-level focus detection ---
OUR_TTY=""
PID=$PPID
while [[ -n "$PID" && "$PID" != "1" && "$PID" != "0" ]]; do
    TTY=$(ps -o tty= -p "$PID" 2>/dev/null | tr -d ' ')
    if [[ -n "$TTY" && "$TTY" != "??" ]]; then
        OUR_TTY="/dev/$TTY"
        break
    fi
    PID=$(ps -o ppid= -p "$PID" 2>/dev/null | tr -d ' ')
done

if [[ -z "$OUR_TTY" ]]; then
    exit 0
fi

FRONTMOST=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null)

ACTIVE_TTY=""
case "$FRONTMOST" in
    Terminal)
        ACTIVE_TTY=$(osascript -e 'tell application "Terminal" to get tty of selected tab of front window' 2>/dev/null)
        ;;
    iTerm2)
        ACTIVE_TTY=$(osascript -e 'tell application "iTerm2" to tell current session of current tab of current window to return tty' 2>/dev/null)
        ;;
esac

if [[ -n "$ACTIVE_TTY" && "$ACTIVE_TTY" == "$OUR_TTY" ]]; then
    exit 0
fi

# --- Identify the instance ---
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
PROJECT=$(basename "${CWD:-unknown}")

# Look up session name from session metadata
SESSION_NAME=""
if [[ -n "$SESSION_ID" ]]; then
    for f in ~/.claude/sessions/*.json; do
        [[ -f "$f" ]] || continue
        if jq -e --arg sid "$SESSION_ID" '.sessionId == $sid' "$f" >/dev/null 2>&1; then
            SESSION_NAME=$(jq -r '.name // empty' "$f" 2>/dev/null)
            break
        fi
    done
fi

INSTANCE="${SESSION_NAME:-$PROJECT}"

# --- Determine event type and build notification ---
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [[ -n "$TOOL_NAME" ]]; then
    # PermissionRequest — show tool params
    TITLE="${INSTANCE} — Approve ${TOOL_NAME}?"
    TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty')
    case "$TOOL_NAME" in
        Bash)
            BODY=$(echo "$TOOL_INPUT" | jq -r '.command // empty' | head -c 200) ;;
        Edit)
            BODY=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty') ;;
        Write)
            BODY=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty') ;;
        Read)
            BODY=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty') ;;
        *)
            BODY=$(echo "$TOOL_INPUT" | jq -c '.' 2>/dev/null | head -c 200) ;;
    esac
    BODY="${BODY:-$TOOL_NAME}"

elif [[ -n "$TRANSCRIPT_PATH" && -f "$TRANSCRIPT_PATH" ]]; then
    # Stop: check elapsed time, show summary
    LAST_PROMPT_ID=$(grep '"type":"user"' "$TRANSCRIPT_PATH" | tail -1 | jq -r '.promptId // empty')
    PROMPT_TS=$(grep "\"promptId\":\"$LAST_PROMPT_ID\"" "$TRANSCRIPT_PATH" | head -1 | jq -r '.timestamp // empty')
    PROMPT_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${PROMPT_TS%%.*}" +%s 2>/dev/null)

    if [[ -z "$PROMPT_EPOCH" ]]; then
        exit 0
    fi

    NOW=$(date +%s)
    ELAPSED=$((NOW - PROMPT_EPOCH))

    if (( ELAPSED < 3 )); then
        exit 0
    fi

    if (( ELAPSED >= 60 )); then
        TIME_STR="$((ELAPSED / 60))m $((ELAPSED % 60))s"
    else
        TIME_STR="${ELAPSED}s"
    fi

    # Use last_assistant_message from stdin if available, fall back to transcript
    SUMMARY=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' | head -c 120)
    if [[ -z "$SUMMARY" ]]; then
        SUMMARY=$(grep '"type":"assistant"' "$TRANSCRIPT_PATH" | tail -5 | jq -r '.message.content[]? | select(.type == "text") | .text' 2>/dev/null | tail -1 | head -c 120)
    fi

    TITLE="${INSTANCE} — Done (${TIME_STR})"
    BODY="${SUMMARY:-Done}"

else
    exit 0
fi

/opt/homebrew/bin/hs -c "hs.notify.new({title=[==[${TITLE}]==], informativeText=[==[${BODY}]==], soundName=\"Glass\", withdrawAfter=0}):send()" 2>/dev/null
