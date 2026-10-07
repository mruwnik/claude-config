# live-tests

Gives Claude a `run_tests` tool. Each run shows live progress on screen, and Claude gets a
compact summary back: counts, failures with trimmed tracebacks, and the path to the full log.

## Setting it up

1. **Often nothing:** pytest projects (`pyproject.toml` mentioning pytest, or `pytest.ini`)
   and projects with a `package.json` `test` script are detected.
2. **Otherwise ask Claude** to "set up run_tests for this project". The bundled
   `live-tests:setup-tests` skill tells it how: look at the project, write
   `.claude/tests.json`, then run each suite to check that it reports counts.
   `run_tests` itself points agents at the skill whenever there's no config, the config is
   invalid (it names the file, suite and field), or a run prints no progress.
3. **Or write it yourself**, e.g. `.claude/tests.json`:
   ```json
   { "suites": { "unit": { "argv": ["uv", "run", "pytest"], "runner": "pytest" } } }
   ```
   Templates for node, build steps, subfolders, jest and other runners are in
   [`skills/setup-tests/SKILL.md`](skills/setup-tests/SKILL.md). The full reference is below.

## Where results show

`/tests-view footer|band|band-right|pane` picks the place, remembered across sessions:

- `footer` (default): one line per run at the right end of the prompt footer, under the
  footer's own modes, e.g. `▶ unit [worker-2] 142/380 37% ✗3 12s`.
- `band` / `band-right`: above the prompt, one line per run plus its latest failing tests.
- `pane`: a docked side pane in the fullscreen layout, with the same content as the band.

A run started by a subagent is labelled with its name, e.g. `unit [worker-2]` (or
`[subagent]` when it has none); a run from the main conversation has no label.

## Options

Set in `/plugin` under live-tests:

- `footerFinishedRuns` (default 3): the footer shows every running run but only this many
  finished ones, those that ended last. Hidden runs keep their logs and summaries; the band
  and the pane still show every run.

## Background runs and subagents

`run_tests({ background: true })` starts the suite as a single Bash background task and
returns right away with its task id, so the caller can keep working while the display keeps
showing progress, marked `(bg)`. When the task ends:

- **Started by the main conversation:** the summary arrives with Claude Code's completion
  notice. Mid-turn it's a row right after the notice; when the session was idle it's added to
  the notice itself.
- **Started by a subagent or teammate:** the main conversation gets nothing. While the agent
  is still running (or idle, for a teammate) it gets the full summary as a message in its own
  conversation; once it has ended, nobody gets it, and the result stays in the footer, the run
  record and the log. Claude Code sends the Bash task's completion notice to main (the mod's
  Bash calls run in main's loop), so the mod answers that notice's `prompt.submit` without
  passing it on: it never enters main. A notice that reaches main another way (as a row
  `session.append` stores, which cannot be dropped) is left as it is, with nothing added.

Early failure notices (see `failureNotices` below) follow the same rules: main's own runs send
them to main, a subagent's to that subagent while it listens, and to nobody once it has ended.

A subagent with nothing else to do should run in the foreground: it would otherwise end
before the summary arrives.

Subagents working in a git worktree pass `cwd` (their worktree path): the suite runs there,
its logs live in that worktree's `.claude/live-tests/`, and the config is read from that
folder, each file falling back to the session root's copy (a worktree has the committed
`tests.json`, not the personal `tests.local.json`). The same suite can run at once in
different folders, but not twice in one.

A foreground run that outlasts the Bash timeout (10 minutes at most), or that the person sends
to the background with ctrl+b, is followed the same way. The task can be stopped with TaskStop.

## Safety

Every step runs through the **Bash tool** (`$.tool.call`), so it gets the same permission
check, auto-mode classifier and sandbox as a command Claude typed itself, and the approver
sees the real command. The model chooses only a suite name and extra `args`, and the args
are shell-quoted. Running tests still runs project code (`conftest.py`, package scripts),
exactly as `npm test` in Bash would.

## Configuring a project

With no config, the mod looks for pytest (`pyproject.toml` mentioning pytest, or
`pytest.ini`; run through `uv run` when there is a `uv.lock`) or a `package.json` `test`
script.

Otherwise write `.claude/tests.json` (committed). `.claude/tests.local.json` (personal, not
committed) is merged over it suite by suite, the same way settings files are.

```json
{
  "default": "unit",
  "suites": {
    "unit": { "argv": ["uv", "run", "pytest"], "runner": "pytest" },
    "engine": {
      "description": "engine cljs + js tests",
      "cwd": "engine",
      "env": { "CI": "1" },
      "timeoutMs": 600000,
      "steps": [
        { "label": "compile", "argv": ["npx", "shadow-cljs", "compile", "test"] },
        { "label": "cljs", "argv": ["node", "out/test.cjs"], "runner": "events" },
        { "label": "js", "argv": ["npm", "run", "test:js"], "runner": "node-test" }
      ]
    }
  }
}
```

- `argv` + `runner` is shorthand for a suite with one step.
- Steps run in order and stop at the first failing step.
- `run_tests` `args` go to the last step, or to any step with `"acceptsArgs": true`.
- `cwd` is relative to the project root. A step's `env` and `cwd` apply on top of the suite's.
- Logs are written to `.claude/live-tests/` (which ignores itself in git), one log and events
  file per run and step; the newest 10 runs per suite are kept.
- `concurrency`: `args` (default) refuses only a run with the same args as one already running
  in that folder, `exclusive` allows one at a time, `any` never refuses.
- `failureNotices`: `auto` (default), `each`, `first` or `off`. A background run sends failed
  tests to its caller before it ends: `each` at once, then at most one batch a minute; `auto`
  likewise once it has run 2 minutes. The run_tests `failureNotices` argument overrides it.
- `node-test` puts the inherited `NODE_OPTIONS` back as its reporter loads, so a test that starts
  its own `node --test` gets a plain one.

### Runners

| runner      | how it reports progress                                                                      |
|-------------|----------------------------------------------------------------------------------------------|
| `pytest`    | loads a bundled pytest plugin (`PYTHONPATH` + `PYTEST_ADDOPTS=-p live_tests_pytest`)          |
| `node-test` | loads a bundled node:test reporter via `NODE_OPTIONS` (the spec reporter still goes to the log) |
| `events`    | (default) nothing is injected; the command prints `@@test` lines itself                        |

A runner that can't be injected (e.g. it runs inside Docker) or an unusual harness uses
`events`. Without `@@test` lines the step still runs, but the summary only has the exit code
and the last 40 lines of output.

## The `@@test` protocol

Print one line per event to stdout (it may follow other text on the same line):

```
@@test {"event":"plan","total":120}                         expected tests (adds up across plan events)
@@test {"event":"result","name":"ns/foo-test","outcome":"passed"}
@@test {"event":"result","name":"ns/bar-test","outcome":"failed","message":"expected 1, got 2\n..."}
@@test {"event":"progress","done":3,"total":46,"unit":"files"}   when the test total isn't known
@@test {"event":"phase","name":"compiling"}
```

`outcome` is one of `passed`, `failed`, `error` or `skipped`.

Each run sets `LIVE_TESTS_NONCE`; an emitter that writes `@@test:<nonce> {...}` cannot be confused
with test output that happens to contain `@@test {`. The bundled pytest and node:test emitters
write only that form and their runners accept only it; `events` suites accept both.
Each run also exports `LIVE_TESTS_RUN` (its run id) and, for a subagent's or teammate's run, `LIVE_TESTS_AGENT_ID` and `LIVE_TESTS_AGENT_NAME` (when known), so process watchers such as agent-usage can attribute suite processes.

`exec-tests/` holds tests that run real suite commands (`node --test exec-tests/*.test.mjs`),
which the plugin test kit cannot.

For cljs.test, for example, a custom `:main` for shadow-cljs's `:node-test` target can print
these lines from `cljs.test/report` methods: note `:fail` / `:error` messages for the current
var, then print one `result` per var at `:end-test-var` (`:pass` fires per assertion, not per test).
