#!/bin/bash
# Block gh CLI commands - gh is not installed, use alternatives

command=$(jq -r '.tool_input.command // ""' 2>/dev/null)

# Match 'gh' as a standalone command (not as part of another word like 'grep')
if echo "$command" | grep -qE '(^|[;&|]|[[:space:]]|\$\()gh[[:space:]]'; then
    cat >&2 << 'EOF'
`gh` is not installed. For GitHub access:

**Issues/PRs:**
- Private repos: Use equistamp tools (mcp__plugin_equistamp-all_equistamp__github_fetch)
- Public repos: Use WebFetch with the GitHub URL

**Viewing code:**
- Private repos: Check ~/code or ask user for access
- Public repos: Clone to /tmp

If you were asked to do a code review, use the differ tools.
EOF
    exit 2
fi

exit 0
