#!/bin/bash
# Show a macOS notification when Claude finishes or needs approval,
# if the terminal tab isn't active.
# Works at the TAB level via TTY comparison.
# Used by Stop, StopFailure, PermissionRequest and PostCompact hooks.

INPUT=$(cat)

# Each session voices its events from a sound pack (see sound-packs/); these
# system sounds from /System/Library/Sounds are the fallback when none are installed.
SOUND_ASK="Funk"       # question picker open mid-turn
SOUND_PLAN="Hero"      # plan awaiting approval
SOUND_QUESTION="Pop"   # turn ended asking you something
SOUND_PERMISSION="Sosumi"  # work is blocked on an approval
SOUND_DONE="Glass"
SOUND_ERROR="Basso"    # turn died on an API error

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
    ghostty)
        # Ghostty's AppleScript exposes no tty, so identify our terminal once by
        # briefly retitling it with a unique token, then cache the id per tty.
        CACHE="${TMPDIR:-/tmp}/claude-ghostty-terminals/$(basename "$OUR_TTY")"
        OUR_TERM=$(cat "$CACHE" 2>/dev/null)
        if [[ -z "$OUR_TERM" ]] || [[ $(osascript -e "tell application \"Ghostty\" to exists terminal id \"$OUR_TERM\"" 2>/dev/null) != true ]]; then
            TITLES=$(osascript -e 'tell application "Ghostty"
                set out to ""
                repeat with t in terminals
                    set out to out & (id of t) & (character id 9) & (name of t) & (character id 10)
                end repeat
            end tell' 2>/dev/null)
            TOKEN="claude-probe-$$-$RANDOM"
            printf '\033]2;%s\007' "$TOKEN" > "$OUR_TTY"
            OUR_TERM=""
            for _ in 1 2 3 4 5 6 7 8 9 10; do
                OUR_TERM=$(osascript -e "tell application \"Ghostty\" to get id of (first terminal whose name is \"$TOKEN\")" 2>/dev/null) && break
                sleep 0.1
            done
            printf '\033]2;%s\007' "$(awk -F'\t' -v id="$OUR_TERM" '$1 == id { sub(/^[^\t]*\t/, ""); print; exit }' <<< "$TITLES")" > "$OUR_TTY"
            [[ -n "$OUR_TERM" ]] && mkdir -p "$(dirname "$CACHE")" && echo "$OUR_TERM" > "$CACHE"
        fi
        FOCUSED_TERM=$(osascript -e 'tell application "Ghostty" to get id of focused terminal of selected tab of front window' 2>/dev/null)
        [[ -n "$OUR_TERM" && "$OUR_TERM" == "$FOCUSED_TERM" ]] && exit 0
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
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')

if [[ "$EVENT" == StopFailure ]]; then
    ERROR=$(echo "$INPUT" | jq -r '.error // "unknown"')
    # Session limits are expected waits, not something to react to.
    [[ "$ERROR" == rate_limit ]] && exit 0
    TITLE="${INSTANCE} — API error (${ERROR})"
    BODY=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' | head -c 120)
    SOUND="$SOUND_ERROR"; STATE="error"

elif [[ "$EVENT" == PostCompact ]]; then
    # A manual /compact ends without a Stop.
    TITLE="${INSTANCE} — Compacted"
    BODY="Ready to continue"
    SOUND="$SOUND_DONE"; STATE="done"

elif [[ -n "$TOOL_NAME" ]]; then
    # PermissionRequest — show tool params
    TITLE="${INSTANCE} — Approve ${TOOL_NAME}?"
    SOUND="$SOUND_PERMISSION"; STATE="permission"
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
        AskUserQuestion)
            TITLE="${INSTANCE} — Question"; SOUND="$SOUND_ASK"; STATE="ask"
            BODY=$(echo "$TOOL_INPUT" | jq -r '.questions[0].question // empty') ;;
        ExitPlanMode)
            TITLE="${INSTANCE} — Plan ready"; SOUND="$SOUND_PLAN"; STATE="plan" ;;
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

    BODY="${SUMMARY:-Done}"

    # Classify the turn by what happened since the last real user prompt.
    START=$(jq -r 'select(.type == "user" and .isMeta != true and (.message.content | type) == "string") | input_line_number' "$TRANSCRIPT_PATH" | tail -1)
    EDITS=$(tail -n +"${START:-1}" "$TRANSCRIPT_PATH" | jq -s '[.[] | .message.content? | arrays | .[]
        | select(.type == "tool_use" and (.name | test("^(Edit|Write|MultiEdit|NotebookEdit)$"))) | .input.file_path // .input.notebook_path] | unique | length')

    # Asks often come in prose or mid-paragraph, so a trailing "?" alone misses most of them.
    if echo "$INPUT" | jq -e '(.last_assistant_message // "") | split("\n\n") | last // ""
        | test("\\?|say the word|want me to|shall i|should i|your call|let me know|once you|go-ahead|do you want|(waiting|blocked) on you|need you to"; "i")' >/dev/null; then
        KIND="Waiting on you"; SOUND="$SOUND_QUESTION"; STATE="question"
    elif [[ $(echo "$INPUT" | jq '[.background_tasks[]? | select(.status == "running" and .type != "teammate")] | length') -gt 0 ]]; then
        # Background work is still running and will wake this session again. Teammates
        # are excluded: they stay "running" while idle, which would mute the session for good.
        exit 0
    else
        SOUND="$SOUND_DONE"; STATE="done"
        KIND="Answered"
        (( EDITS > 0 )) && KIND="Edited ${EDITS} file$( (( EDITS > 1 )) && echo s)"
    fi
    TITLE="${INSTANCE} — ${KIND} (${TIME_STR})"

else
    exit 0
fi

SOUND_LUA="soundName=\"${SOUND}\","
if PACK_NAME=$(~/.claude/hooks/sound-packs/play.sh "$SESSION_ID" "$STATE"); then
    TITLE="${TITLE/${INSTANCE}/${INSTANCE} [${PACK_NAME}]}"
    SOUND_LUA=""
fi

/opt/homebrew/bin/hs -c "hs.notify.new({title=[==[${TITLE}]==], informativeText=[==[${BODY}]==], ${SOUND_LUA} withdrawAfter=0}):send()" 2>/dev/null
