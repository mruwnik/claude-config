#!/usr/bin/env python3
"""
PreToolUse hook that blocks git push, git remote set-url, gh, and branch creation commands.

Directs users to use the mcp__differ-review__request_review tool instead.
"""

import json
import re
import sys


BLOCKED_PATTERNS = [
    (r"\bgit\s+push\b", "git push"),
    (r"\bgit\s+remote\s+set-url\b", "git remote set-url"),
    (r"\bgh\s+", "gh (GitHub CLI)"),
    (r"\bgit\s+checkout\s+-b\b", "git checkout -b (branch creation)"),
    (r"\bgit\s+switch\s+-c\b", "git switch -c (branch creation)"),
    (r"\bgit\s+branch\s+(?!-[dD])", "git branch (branch creation)"),
]


def main():
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    tool_name = hook_input.get("tool_name", "")
    tool_input = hook_input.get("tool_input", {})

    # Only check Bash commands
    if tool_name != "Bash":
        sys.exit(0)

    command = tool_input.get("command", "")

    for pattern, name in BLOCKED_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            result = {
                "decision": "block",
                "reason": (
                    f"Blocked: {name} commands are disabled.\n\n"
                    "Use the mcp__differ-review__request_review tool instead to:\n"
                    "  - Push changes and create a PR\n"
                    "  - Request external review\n\n"
                    "Work on the current branch. The request_review tool handles pushing."
                ),
            }
            print(json.dumps(result))
            sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
