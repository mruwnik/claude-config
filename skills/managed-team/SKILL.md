---
name: managed-team
description: Use when facing multiple tasks that need parallel execution by a team of named agents pulling from a differ-review kanban board, or when asked to find and fix bugs across a codebase with coordinated workers
---

# Managed Team

Spin up a **real agent team** — not subagents you micromanage. Workers are autonomous peers that self-organize via the differ-review kanban board. You act as **project manager only**: you set up the board, spawn the team, monitor progress, and merge approved branches. You NEVER implement anything yourself.

**This is NOT the subagent pattern.** Do not spawn one agent, wait for it, then spawn another. Create the team, spawn all workers simultaneously, and let them pull work from the board. The PM can assign tasks or ask workers to specialize (e.g., "focus on API endpoints"), but workers are autonomous — they decide how to do the work.

## Modes

### Execute Board
Tasks already exist on the board. Spawn workers, they pull and complete tasks.

```
/managed-team execute
```

### Discover and Fix
No tasks yet. Spawn discovery agents (pentesters, quality reviewers), create tasks from findings, then spawn fixers.

```
/managed-team discover-and-fix
```

## Core Pattern

```
Workers (in worktrees):
  take task → do work → commit on branch → mark "needs-review" → next task

Reviewer (quality gate):
  pick up "needs-review" → review branch → add comments → if clean: mark "done"
                                                        → if issues: mark "pending" (worker picks it back up)

PM (lightweight — preserve context window):
  create board + team → spawn all agents → monitor → merge approved branches → run /checkpoint periodically → report
```

All roles are peers on the same team. No nesting — the reviewer is a team member, not a subagent spawned by workers.

### Task Status Flow

```
pending → in_progress (worker takes it)
       → needs-review (worker commits, ready for review)
       → done (reviewer approves)
       OR → pending (reviewer adds comments, worker picks it back up to fix)
```

## Setup

### 1. Create Team, Work Log, and Generate Names

```python
TeamCreate(name="team-name")  # create the team FIRST
mcp__differ-review__random_name()  # one per worker + reviewer
```

Create a work log file at `team-logs/{team-name}.md`. This is the team's shared scratchpad — workers append notes here as they work (discoveries, blockers, decisions, handoff info). The PM also uses it to record checkpoints and status.

```markdown
# Team Log: {team-name}
Started: {date/time}
Goal: {brief description of what the team is working on}
Workers: {name1}, {name2}, {name3}
Reviewer: {reviewer-name}

---

## Log
```

### 2. Worker Prompt Template

Workers run in **worktrees** (`isolation: "worktree"`) so they each get an isolated copy of the repo. No merge conflicts between workers during implementation.

```
You are {NAME}, a member of team {TEAM}. You are an autonomous worker. Pull tasks from the differ-review kanban board, implement them, and commit. Keep working until the board is empty.

TEAM LOG: {LOG_PATH}
Append notes as you work — what you're doing, blockers, discoveries, decisions. Read it before starting to see what others have done.

WORKFLOW:
1. Read the team log to see current state
2. mcp__differ-review__list_tasks(repo_path="{REPO}") to see pending tasks
3. Pick highest-priority pending task
4. mcp__differ-review__take_task(task_id=..., worker_name="{NAME}") to claim it
5. Log what you're working on
6. Do the work (read, fix, test)
7. Stage and commit:
   a. git add <file> for each changed file (NOT git add -A)
   b. git commit -m "$(cat <<'EOF'
      <what changed and why>

      Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
      EOF
      )"
8. If the task was previously reviewed and has comments (status was "pending" after review):
   - Check mcp__differ-review__get_pending_feedback for the review session
   - Reply to each comment with add_comment (parent_id) explaining the fix
   - Resolve fixed comments with resolve_comment
9. Log what you did and any relevant findings
10. mcp__differ-review__update_task(task_id=..., status="needs-review",
      note="branch: <branch-name>, files: <list of changed files>")
11. Go back to step 1. Stop when no pending tasks remain.

CONSTRAINTS:
{CONSTRAINTS}
```

### 3. Reviewer Prompt Template

One dedicated team member runs reviews. This keeps everything flat — no nested subagents.

```
You are {NAME}, the reviewer for team {TEAM}. Review completed work and ensure quality. You do NOT implement fixes — you add review comments for workers to address.

TEAM LOG: {LOG_PATH}
Append review summaries. Read it to understand what workers have done.

WORKFLOW:
1. mcp__differ-review__list_tasks(repo_path="{REPO}") — look for tasks with status "needs-review"
2. If none, wait briefly and check again. Stop when all tasks are "done" and no "pending" or "in_progress" tasks remain.
3. For each needs-review task:
   a. Read the task note to get the branch name and files changed
   b. Create/get a differ-review session for that branch:
      mcp__differ-review__get_or_create_session(repo_path="{REPO}", branch="<branch>", target_branch="master")
   c. Review using get_session_diff — look for bugs, edge cases, style, logic errors
   d. If clean:
      - mcp__differ-review__update_task(task_id=..., status="done", note="Reviewed: approved, branch: <branch>")
      - Log approval
   e. If issues:
      - Add comments via mcp__differ-review__add_comment for each issue (with file, line, details)
      - mcp__differ-review__update_task(task_id=..., status="pending",
          note="Review comments added — needs fixes. Session: <session_id>")
      - Log what issues were found
4. Go back to step 1.
```

### 4. Spawn ALL Agents At Once

Spawn all workers + reviewer in a **single message**. Do NOT spawn sequentially.

```python
# Scale workers to the task count. Worktrees eliminate file contention,
# so the main limit is just how many tasks you have.
Agent(name=name1, subagent_type="general-purpose", mode="bypassPermissions",
      team_name=team, isolation="worktree", prompt=worker_prompt_1, run_in_background=True)
Agent(name=name2, subagent_type="general-purpose", mode="bypassPermissions",
      team_name=team, isolation="worktree", prompt=worker_prompt_2, run_in_background=True)
# ... add more as needed

# Reviewer (no worktree — reviews branches from main repo)
Agent(name=reviewer_name, subagent_type="general-purpose", mode="bypassPermissions",
      team_name=team, prompt=reviewer_prompt, run_in_background=True)
```

After spawning, move immediately to PM duties. Do NOT wait for agents to finish.

## Project Manager Responsibilities

You are the PM. Keep your context window lean — do lightweight coordination only.

You:
- Set up the board and team
- Spawn agents
- Monitor progress (check board + read team log)
- Merge approved branches (`git merge <branch>` — this is cheap)
- Run `/checkpoint` periodically
- Unblock stuck workers
- Report progress

**Escape hatch:** For trivial fixes (typos, one-line changes) that are blocking progress, the PM may fix directly. But if you're about to read more than one file or write more than 5 lines, STOP and delegate.

### Monitor
Check `mcp__differ-review__list_tasks` periodically. Also read the team log — workers record discoveries and blockers there.

### Merge Approved Branches
When the reviewer marks a task "done" with a branch name, merge it:
```bash
git merge <branch-name>
```
If there's a conflict, create a task for a worker to resolve it.

### Create Tasks from Findings
When discovery agents report, create tasks with severity in title:
```
mcp__differ-review__create_task(repo_path=REPO, title="[HIGH] Fix X", description="...")
```

### Handle Stale Agents
If an agent goes idle without completing its task, send a nudge via SendMessage. If unresponsive after 2 nudges, shut down and respawn with a fresh name.

### Checkpoints
Periodically (e.g., after every 3-4 tasks complete, or when half the board is done), run `/checkpoint` to review all accumulated changes on the integration branch against master. This catches cross-cutting issues that per-task reviews miss.

### Avoid Full Test Suite
Broadcast to workers: run only targeted tests relevant to their change. Full suite runs should be a separate task at the end.

## Discovery Agent Types

For discover-and-fix mode, spawn these as background agents:

| Type | Focus | Count |
|------|-------|-------|
| **Pentester** | Auth, access control, crypto, input validation | 2-3 |
| **Quality** | Code bugs, UX issues, performance | 1-2 |

Discovery agents report findings but do NOT fix. Their output becomes tasks.

## Constraints to Always Include

```
- Use {VENV_PATH} for all Python/pytest commands (if applicable)
- Do NOT use git stash
- Run only targeted tests, not the full suite
- Do NOT modify files outside your task scope
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| **Using subagent pattern instead of team** | Create a TeamCreate team, spawn all agents at once in background. Do NOT spawn one, wait, spawn another. |
| **PM does implementation work** | Delegate. Escape hatch only for trivial (<5 line) blockers. |
| **PM burns context reading diffs** | Let the reviewer handle all code review. PM only does lightweight merges and board checks. |
| More workers than tasks | Scale workers to task count. Excess workers are harmless but wasteful. |
| Workers run full test suite | Broadcast: targeted tests only. |
| Stale shutdown requests kill respawned agents | Use fresh names for respawns. |
| Workers duplicate each other's tasks | differ-review take_task prevents this. |
| No verification at end | Always run full test suite as final task. |
