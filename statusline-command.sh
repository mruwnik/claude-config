#!/bin/bash

# Read JSON input from stdin
input=$(cat)

# Extract current directory from JSON
cwd=$(echo "$input" | jq -r '.workspace.current_dir')

# Get just the directory name (like %c in zsh)
dir_name=$(basename "$cwd")

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

# Output: cyan directory name + git info
printf "\033[0;36m%s\033[0m%s" "$dir_name" "$git_info"
