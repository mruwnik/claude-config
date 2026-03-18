---
description: Review all accumulated changes on current branch against master/main. Use as an integration checkpoint during or after agent team work.
allowed-tools: Bash(git:*), Read, Glob, Grep, Agent, mcp__differ-review__get_or_create_session, mcp__differ-review__get_pending_feedback, mcp__differ-review__get_session_diff, mcp__differ-review__add_comment, mcp__differ-review__resolve_comment, mcp__differ-review__submit_review, mcp__differ-review__random_name, mcp__differ-review__register_files
argument-hint: [focus area or specific concerns]
---

Integration checkpoint: review accumulated changes, run tests and linting, assess merge-readiness.

Context: $ARGUMENTS

## 1. Identify Scope

Determine the base branch:
```bash
git rev-parse --abbrev-ref HEAD        # current branch
git log --oneline master..HEAD         # commits since divergence
git diff --stat master...HEAD          # files changed summary
```

Report: current branch, number of commits since master, files changed.

## 2. Detect and Run Tests + Linting

Look at the project to figure out what tools are available. Check for:
- Config files: `pyproject.toml`, `package.json`, `Makefile`, `Cargo.toml`, `build.gradle`, `.eslintrc.*`, `tox.ini`, `setup.cfg`, etc.
- CLAUDE.md or README for documented test/lint commands
- CI config: `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`

Run whatever testing and linting the project uses. Common examples:
- Python: `pytest`, `black --check`, `isort --check`, `mypy`, `ruff`
- JS/TS: `npm test`, `npm run lint`
- Rust: `cargo test`, `cargo clippy`
- Go: `go test ./...`, `golangci-lint run`

If the project has a `Makefile` with `test`/`lint` targets or a CI config, prefer those — they're the canonical way to run checks.

Report results. Note any failures for the final report.

## 3. Create Review Session

```
mcp__differ-review__get_or_create_session(
    repo_path="<repo>",
    branch="<current branch>",
    target_branch="master"
)
```

This gives a differ-review session covering the full branch diff against master.

## 4. Run Review

Generate a name with `mcp__differ-review__random_name()`, then spawn review agents in parallel:

1. **code-reviewer** — overall quality, architecture, consistency across changes
2. **bug-finder** — cross-cutting bugs, integration issues between separate commits

Each agent should:
- Fetch the diff via `get_session_diff(session_id=...)`
- Focus on issues that span multiple commits (per-commit issues should have been caught by per-task reviews)
- Add comments via `add_comment` with `author="{name}"`
- Return a brief summary

## 5. Report

After agents complete:
- Call `get_pending_feedback` to collect all findings
- Submit review via `submit_review`
- Report to user:
  - **Tests**: pass/fail count, any failures
  - **Linting**: clean or list of issues
  - **Review**: issue count by severity, cross-cutting concerns
  - **Verdict**: whether the branch looks ready to merge

If there are critical issues (test failures, review findings), suggest creating tasks for them (for the agent team to pick up, or to fix directly).
