---
description: Review current changes using differ-review
allowed-tools: Bash(git:*), Read, Glob, Grep, Task, mcp__differ-review__*
argument-hint: [focus area or specific instructions]
---

Review the current uncommitted changes in this repository.

Additional context from user: $ARGUMENTS

## Setup

1. Get or create a review session using `mcp__differ-review__get_or_create_session` with the current repo path
2. Generate a reviewer name using `mcp__differ-review__random_name()` for comment attribution
3. Check for untracked files using `git status --porcelain` (lines starting with `??`)
   - Filter by file extension/path to find likely source files (e.g., .cljs, .ts, .py, .js, .go, etc.)
   - Exclude obvious non-review paths: node_modules/, .git/, build/, dist/, target/, __pycache__/, *.log, .DS_Store
   - If there are potentially relevant untracked source files, ask the user if they should be added to the review
   - Register confirmed files using `mcp__differ-review__register_files`
4. Get a **brief summary** of what changed using `mcp__differ-review__get_context` - do NOT fetch the full diff yet
5. Note the session_id and reviewer name for passing to review agents

## Review

**Deep review** - Only when user explicitly requests "deep", "thorough", or "careful" in $ARGUMENTS. Do NOT auto-trigger based on code type. Launch these agents **in parallel** using the Task tool:

1. **code-reviewer** - Overall code review with severity classification
2. **bug-finder** - Find subtle bugs, edge cases, failure modes
3. **code-simplifier** - Identify simplification opportunities
4. **python-type-checker** - Type safety analysis (only if Python files changed)

Each agent prompt should include:
- The session_id so they can fetch their own diff via `mcp__differ-review__get_session_diff`
- Your assigned name for attribution (e.g., `author="Aleph"`)
- Instructions to add comments using `mcp__differ-review__add_comment` for specific issues
- Request to return a **brief summary** (not the full diff or detailed findings)

**Basic review (default)** - Delegate to a single **code-reviewer** agent:

```
Review session {session_id}. Fetch the diff using get_session_diff, review for:
- Bugs and edge cases
- Security issues
- Performance concerns
- Code style
Add comments via add_comment for issues found. Use author="{your_assigned_name}" for attribution.
Return a 5-10 line summary only.
```

**Important:** Do NOT fetch the diff in main context - agents fetch it themselves. This saves ~19k of context per review.

**Name attribution:** Generate a name using `mcp__differ-review__random_name()` at setup. Pass this name to subagents so review comments are properly attributed. E.g., if you got "Tenser", tell agents to use author="Tenser".

## Finalize

After agents return their summaries:

1. Submit the review using `mcp__differ-review__submit_review`
   - The body should be **3-4 lines max**: verdict, critical issue count, one-sentence summary
   - Example: "**Request Changes** - 2 critical, 4 major issues. Pagination not implemented (data loss) and open redirect in OAuth need fixing before merge."
   - All detail goes in line comments (added by agents), not the summary
   - For deep reviews: include cross-cutting concerns identified by multiple agents

## Reporting

- **To user (terminal)**: Be detailed. List all issues by severity, include file references, explain the "why"
- **To GitHub (submit_review body)**: Be terse. Verdict + issue counts + one-liner. That's it.

## Review Style

Be direct and unvarnished. No praise sandwiches. If code is bad, say so and why.
Challenge assumptions. Call out "works but is wrong". Tolerate no errors.
Skip the "nice work!" fluff - the user wants truth, not comfort.
