#!/bin/bash

# Read JSON input from stdin
input=$(cat)

# Single jq pass. Empty string for anything absent:
#  - rate_limits is missing entirely until the first API response of a session,
#    and always for non-subscription auth, so both percentages may be blank.
# Fields are joined on US (0x1f), NOT tab: tab is an IFS whitespace character,
# so `read` would collapse a run of them and silently shift every field left
# whenever one of the optional values is empty.
# Percentages are rounded in jq, not printf -- bash's printf %.0f rejects
# "12.4" under any locale whose decimal separator isn't ".".
IFS=$'\x1f' read -r cwd model_name tokens five week < <(
    printf '%s' "$input" | jq -r '[
        (.workspace.current_dir // ""),
        (.model.display_name // "?"),
        ((.context_window.total_input_tokens // 0) / 1000 | floor),
        (.rate_limits.five_hour.used_percentage // "" | if type == "number" then round else . end),
        (.rate_limits.seven_day.used_percentage // "" | if type == "number" then round else . end)
    ] | map(tostring) | join("\u001f")'
)

# Get just the directory name (like %c in zsh)
dir_name=$(basename "$cwd")

# Model initial (O for Opus, S for Sonnet, H for Haiku, F for Fable)
model_letter=$(printf '%s' "${model_name:0:1}" | tr '[:lower:]' '[:upper:]')

# Usage segment: "5h:12%" green under 50, yellow under 80, red at/above 80.
# Prints nothing when the window is absent, so the line just loses the segment.
usage_seg() {
    local label=$1 rounded=$2 color
    [ -n "$rounded" ] || return 0
    if [ "$rounded" -ge 80 ]; then
        color='0;31'
    elif [ "$rounded" -ge 50 ]; then
        color='0;33'
    else
        color='0;32'
    fi
    printf " \033[2;37m%s:\033[0m\033[%sm%s%%\033[0m" "$label" "$color" "$rounded"
}

usage_info="$(usage_seg 5h "$five")$(usage_seg 7d "$week")"

# Get git branch if in a git repo
git_info=""
if cd "$cwd" 2>/dev/null && git rev-parse --git-dir > /dev/null 2>&1; then
    branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)
    if [ -n "$branch" ]; then
        # Check if repo is dirty (using --no-optional-locks to avoid lock issues)
        if ! git --no-optional-locks diff --quiet 2>/dev/null || ! git --no-optional-locks diff --cached --quiet 2>/dev/null; then
            # Dirty repo - show ✗
            git_info=$(printf " \033[1;34mgit:(\033[0;31m%s\033[1;34m) \033[0;33m✗\033[0m" "$branch")
        else
            # Clean repo
            git_info=$(printf " \033[1;34mgit:(\033[0;31m%s\033[1;34m)\033[0m" "$branch")
        fi
    fi
fi

# Output: cyan directory name + git info + magenta model letter + dim [Nk] context size + usage
# usage_info is passed as an argument, not spliced into the format string --
# it contains literal % signs that printf would otherwise treat as directives.
printf "\033[0;36m%s\033[0m%s \033[0;35m%s\033[0m\033[2;37m[%sk]\033[0m%s" \
    "$dir_name" "$git_info" "$model_letter" "$tokens" "$usage_info"
