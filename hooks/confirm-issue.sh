#!/bin/bash
# Custom confirmation for GitHub issue creation
# Shows formatted issue and prompts for y/n

input=$(cat)
tool_input=$(echo "$input" | jq -r '.tool_input')

repo=$(echo "$tool_input" | jq -r '.repo // "unknown"')
title=$(echo "$tool_input" | jq -r '.title // "No title"')
body=$(echo "$tool_input" | jq -r '.body // ""')
labels=$(echo "$tool_input" | jq -r '.labels // [] | join(", ")')
assignees=$(echo "$tool_input" | jq -r '.assignees // [] | join(", ")')
number=$(echo "$tool_input" | jq -r '.number // empty')

# Colors
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Clear line and print header
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ -n "$number" ]; then
    echo -e "${BOLD}📝 UPDATE ISSUE #${number}${NC}"
else
    echo -e "${BOLD}📋 CREATE ISSUE${NC}"
fi
echo -e "${DIM}Repo: ${repo}${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}${BOLD}${title}${NC}"
echo ""

[ -n "$labels" ] && echo -e "${DIM}Labels:${NC} ${labels}"
[ -n "$assignees" ] && echo -e "${DIM}Assignees:${NC} ${assignees}"
[ -n "$labels" ] || [ -n "$assignees" ] && echo ""

# Print body with basic formatting
echo -e "${DIM}───────────────────────────────────────────────────────────────────────────${NC}"
echo "$body" | while IFS= read -r line; do
    # Headers
    if [[ "$line" =~ ^###\  ]]; then
        echo -e "${BOLD}${line#\#\#\# }${NC}"
    elif [[ "$line" =~ ^##\  ]]; then
        echo -e "${BOLD}${YELLOW}${line#\#\# }${NC}"
    elif [[ "$line" =~ ^#\  ]]; then
        echo -e "${BOLD}${CYAN}${line#\# }${NC}"
    # Checkboxes
    elif [[ "$line" =~ ^-\ \[.\] ]]; then
        echo -e "  ${line}"
    # Bullets
    elif [[ "$line" =~ ^-\  ]]; then
        echo -e "  •${line#-}"
    else
        echo "$line"
    fi
done
echo -e "${DIM}───────────────────────────────────────────────────────────────────────────${NC}"
echo ""

# Prompt for confirmation
echo -en "${GREEN}Create this issue? [y/n]:${NC} "
read -r response </dev/tty

if [[ "$response" =~ ^[Yy]$ ]]; then
    # Output JSON to allow the tool call
    cat << 'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Approved via custom confirmation"}}
EOF
    exit 0
else
    echo -e "${DIM}Issue creation cancelled${NC}"
    exit 2
fi
