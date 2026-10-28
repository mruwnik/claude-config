#!/bin/bash
# play.sh <session_id> <state>: play a random line for the state (permission, ask, plan,
# question, done, error, start) from this session's pack in the background, and print the pack's
# display name. Lines come from states.json, else the matching CESP category.
# Exits 1 if no packs are installed.

SESSION_ID="$1"
STATE="$2"
DIR="$(cd "$(dirname "$0")" && pwd)"
ASSIGNED="$DIR/assigned"

PACKS=$(ls "$DIR/packs" 2>/dev/null)
[[ -z "$PACKS" || -z "$SESSION_ID" ]] && exit 1

PACK=$(cat "$ASSIGNED/$SESSION_ID" 2>/dev/null)
if [[ -z "$PACK" || ! -d "$DIR/packs/$PACK" ]]; then
    # Prefer a pack no other live session has, so the voice identifies the session.
    LIVE=$(jq -r '"\(.pid) \(.sessionId)"' ~/.claude/sessions/*.json 2>/dev/null |
        while read -r PID SID; do kill -0 "$PID" 2>/dev/null && echo "$SID"; done)
    TAKEN=$(for SID in $LIVE; do cat "$ASSIGNED/$SID" 2>/dev/null; echo; done)
    FREE=$(comm -23 <(sort <<< "$PACKS") <(sort -u <<< "$TAKEN"))
    PACK=$(sort -R <<< "${FREE:-$PACKS}" | head -1)
    mkdir -p "$ASSIGNED" && echo "$PACK" > "$ASSIGNED/$SESSION_ID"
fi

MANIFEST="$DIR/packs/$PACK/openpeon.json"
# A curated pack with no line that fits a state borrows the nearest state's lines
# rather than playing one that means something else.
case "$STATE" in
    permission|plan|question) BORROW="ask" ;;
    ask) BORROW="question" ;;
    *) BORROW="" ;;
esac
pick() { jq -r --arg p "$PACK" --arg s "$1" '.[$p][$s][]?' "$DIR/states.json" 2>/dev/null | sort -R | head -1; }
FILE=$(pick "$STATE")
[[ -z "$FILE" && -n "$BORROW" ]] && FILE=$(pick "$BORROW")
if [[ -z "$FILE" ]] && ! jq -e --arg p "$PACK" 'has($p)' "$DIR/states.json" >/dev/null 2>&1; then
    case "$STATE" in
        permission|ask|plan|question) CATEGORY="input.required" ;;
        done) CATEGORY="task.complete" ;;
        error) CATEGORY="task.error" ;;
        start) CATEGORY="session.start" ;;
    esac
    FILE=$(jq -r --arg c "$CATEGORY" '.categories[$c].sounds[]?.file' "$MANIFEST" | sort -R | head -1)
fi
[[ -z "$FILE" ]] && exit 1
nohup afplay "$DIR/packs/$PACK/$FILE" >/dev/null 2>&1 &
jq -r '.display_name' "$MANIFEST"
