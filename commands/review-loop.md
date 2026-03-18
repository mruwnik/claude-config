---
description: Review changes and fix issues iteratively (up to 3 rounds)
allowed-tools: Task, mcp__differ-review__get_or_create_session, mcp__differ-review__get_pending_feedback, mcp__differ-review__random_name
argument-hint: [focus area or specific instructions]
---

Review and fix changes iteratively until all comments are resolved (max 3 rounds).

Additional context from user: $ARGUMENTS

## Setup

1. Get or create a review session using `mcp__differ-review__get_or_create_session` with the current repo path
2. Generate a name using `mcp__differ-review__random_name()` - pass this to all subagents for comment attribution

## Loop (max 3 iterations)

For each round:

### 1. Review
Launch a subagent: "Run /review for session {session_id}. Use author={name} for comments."

### 2. Check
Call `mcp__differ-review__get_pending_feedback`. If no unresolved comments, stop - we're done.

### 3. Fix
Launch a subagent: "Run /fix-review for session {session_id}. Use author={name} for comments."

### 4. Continue?
- If round < 3: go back to Review
- If round = 3: stop and report any remaining issues

## Final Report

Summarize: rounds completed, issues fixed, any remaining unresolved comments.
