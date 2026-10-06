---
name: setup-tests
description: Use when run_tests says no suites are configured, reports a tests config error, or its summary says "no @@test events"; or when asked to set up, fix or add test suites for the live-tests run_tests tool (.claude/tests.json).
---

# Set up run_tests for a project

`run_tests` reads `.claude/tests.json` in the project root (committed, shared) with
`.claude/tests.local.json` (personal, not committed) over it. Goal: every suite reports
live progress and test counts. Work through the steps in order.

## 1. Look at the project

Check, in the folder the tests run from:

| You find | Use template |
|---|---|
| `uv.lock` + pytest (in `pyproject.toml` or `pytest.ini`) | A |
| pytest without uv (`requirements*.txt`, a venv, poetry, `tox.ini`) | B (put the right launcher in `argv`) |
| `package.json` whose `test` script is `node --test ...` | C |
| a build/compile step needed before tests | D |
| tests in a subfolder (monorepo package, `backend/`) | E |
| jest | F |
| anything else: vitest, mocha, cljs.test, cargo, go, tests inside Docker, a Makefile target | G |

Read the project's own docs or CI config (`Makefile`, `.github/workflows/*`, `justfile`,
`CLAUDE.md`) for the command people actually run, and copy it. Several kinds of tests mean
several suites (e.g. `unit`, `e2e`); set `default` to the quick one.

## 2. Write `.claude/tests.json`

`argv` is a list, never a shell string: there's no `&&`, no pipes, no globbing. Use `steps` for
several commands, or `["bash", "-c", "..."]` when you really need a shell.

**A: uv + pytest**
```json
{ "suites": { "unit": { "argv": ["uv", "run", "pytest"], "runner": "pytest" } } }
```

**B: pytest in a venv**
```json
{ "suites": { "unit": { "argv": [".venv/bin/python", "-m", "pytest", "tests"], "runner": "pytest" } } }
```

**C: node --test**
```json
{ "suites": { "unit": { "argv": ["node", "--test"], "runner": "node-test" } } }
```
Call `node --test` directly rather than `npm test`, so the reporter is injected into the
node process that runs the tests. (`["npm", "test", "--"]` also works when the script is plain
`node --test ...`.)

**D: build, then test.** Steps run in order and stop at the first failure. `args` from
run_tests go to the last step.
```json
{
  "suites": {
    "unit": {
      "steps": [
        { "label": "build", "argv": ["npm", "run", "build"] },
        { "label": "test", "argv": ["node", "--test", "dist/"], "runner": "node-test" }
      ]
    }
  }
}
```

**E: subfolder.** `cwd` is relative to the project root.
```json
{
  "default": "api",
  "suites": {
    "api": { "cwd": "services/api", "argv": ["uv", "run", "pytest"], "runner": "pytest" },
    "web": { "cwd": "web", "argv": ["node", "--test"], "runner": "node-test" }
  }
}
```

**F: jest.** No reporter is bundled. Add this file to the project as `.claude/jest-live.cjs`:
```js
class LiveTests {
  onRunStart(results) { this.files = results.numTotalTestSuites; this.done = 0 }
  onTestResult(_test, result) {
    const emit = e => process.stdout.write(`@@test ${JSON.stringify(e)}\n`)
    const ownLines = text => text.split('\n').filter(l => !/node_modules|node:internal|<anonymous>/.test(l)).join('\n')
    for (const t of result.testResults) {
      const outcome = t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : 'skipped'
      emit({ event: 'result', name: t.fullName, outcome, message: ownLines(t.failureMessages.join('\n')) || null })
    }
    emit({ event: 'progress', done: ++this.done, total: this.files, unit: 'files' })
  }
}
module.exports = LiveTests
```
```json
{ "suites": { "unit": { "argv": ["npx", "jest", "--reporters=default", "--reporters=./.claude/jest-live.cjs"], "runner": "events" } } }
```

**G: anything else.** Use `"runner": "events"` (the default). The command runs as-is. For
progress and counts, the test program itself prints one line per event to stdout:
```
@@test {"event":"plan","total":120}
@@test {"event":"result","name":"ns/foo-test","outcome":"passed"}
@@test {"event":"result","name":"ns/bar-test","outcome":"failed","message":"expected 1, got 2"}
@@test {"event":"progress","done":3,"total":46,"unit":"files"}
@@test {"event":"phase","name":"compiling"}
```
`outcome` is `passed`, `failed`, `error` or `skipped`. A line can start mid-output, after
other text. Use the framework's reporter or hook API, e.g. cljs.test `report` methods, a
mocha or vitest custom reporter, or a wrapper script that parses the runner's output.
Without these lines the suite still runs, but the summary has only the exit code and the
last lines of output.

Better: mark each line with the run's nonce, which the run puts in `LIVE_TESTS_NONCE`:
`@@test:<nonce> {"event":"result",...}`. Then a test that happens to print `@@test {` cannot
add or forge a result. The built-in `pytest` and `node-test` runners accept only the
nonce form; `events` suites accept both.

## 3. Verify

Call `run_tests` for each suite (`{"suite": "unit"}`). Read the summary:

- `✓ unit: 52 passed` or `✗ unit: 50 passed, 2 failed (exit 1)` means it's set up. Failing
  tests are the project's business, not the config's.
- `tests config error in <file>: ...` means fix the field it names and retry.
- `no @@test events` / `No live progress` means the runner isn't reporting: check `runner`.
  For `pytest`, the run must keep the environment (`PYTHONPATH`, `PYTEST_ADDOPTS`), which tox,
  nox or Docker may drop: point `argv` at pytest itself, or use G. For
  `node-test`, use node's own test runner. Otherwise go to template F or G.
- The run dies before any tests, e.g. `exit 127` or `command not found`: fix `argv` or `cwd`.

## Field reference

Suite: `argv` + `runner` (one command) **or** `steps` (several), plus optional:

| field | meaning |
|---|---|
| `argv` | the command as a list of strings |
| `runner` | `pytest`, `node-test` or `events` (default): how progress is reported |
| `steps` | list of `{argv, runner?, label?, cwd?, env?, acceptsArgs?}`, run in order |
| `label` | a step's name in the summary (defaults to the command) |
| `cwd` | folder relative to the project root; a step's `cwd` applies on top of the suite's |
| `env` | `{"NAME": "value"}` added to the environment; a step's env applies on top of the suite's |
| `timeoutMs` | Bash timeout, at most 600000. A longer run moves to the background and its summary still arrives |
| `description` | shown to agents in the tool's suite list |
| `acceptsArgs` | `true` on a step that should get run_tests `args`; by default only the last step does |
| `concurrency` | `args` (default), `exclusive` or `any`: which runs of the suite may overlap in one folder. `args` refuses only a run with the same args as one already running, `exclusive` allows one at a time, `any` never refuses. Each run has its own log and events files; the newest 10 runs per suite are kept |
| `failureNotices` | `auto` (default), `each`, `first` or `off`: whether a background run tells the caller about failed tests before it ends. `each` sends the first at once, then at most one batch a minute; `auto` does the same once the run has gone 2 minutes, so quick suites only send their summary; `first` sends one notice. The run_tests `failureNotices` argument overrides it for one call |

Top level: `suites` (required) and `default` (suite name; defaults to the first).

## tests.json or tests.local.json?

- **`tests.json`**: how anyone runs this project's tests. Commit it.
- **`tests.local.json`**: anything specific to this machine or person, such as absolute paths,
  a personal venv, or extra debug suites. It's not committed: add it to `.gitignore` if
  `.claude/` isn't ignored already. A suite with the same name replaces the shared one
  whole, and its `default` wins.

A git worktree has the committed `tests.json`. A missing `tests.local.json` is read from the
session's root. A subagent in a worktree passes its worktree path as run_tests `cwd`.
