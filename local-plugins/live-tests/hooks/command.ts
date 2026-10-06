import type { Runner } from './config'

export type RunFiles = { log: string; events: string }

/** Who started the run, exported so tools watching processes can tell a subagent's suite from main's. */
export type RunLabels = { run: string; agentId: string | null; agentName: string | null }

export type CommandSpec = {
  cwd: string
  argv: readonly string[]
  runner: Runner
  env: Readonly<Record<string, string>>
  emittersDir: string
  files: RunFiles
  /** Marks this run's events, `@@test:<nonce> {`, so test output cannot forge or double-count them. */
  nonce: string
  labels: RunLabels
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const NONCE = /^[A-Za-z0-9]+$/

export const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/** NAME='value' followed by the inherited value, joined by `sep` when set. */
const prepend = (name: string, value: string, sep: string) => `${name}=${shellQuote(value)}"\${${name}:+${sep}$${name}}"`

const injection = (runner: Runner, emittersDir: string): readonly string[] => {
  switch (runner) {
    case 'pytest':
      return [prepend('PYTHONPATH', emittersDir, ':'), prepend('PYTEST_ADDOPTS', '-p live_tests_pytest', ' ')]
    case 'node-test': {
      const reporters = [
        `--test-reporter=${emittersDir}/node-reporter.mjs`,
        '--test-reporter-destination=stdout',
        '--test-reporter=spec',
        '--test-reporter-destination=stderr',
      ]
      // The reporter puts the inherited value back as it loads, so test files and the nodes they start get NODE_OPTIONS as it was.
      return ['LIVE_TESTS_PREV_NODE_OPTIONS="${NODE_OPTIONS-}"', prepend('NODE_OPTIONS', reporters.join(' '), ' ')]
    }
    case 'events':
      return []
  }
}

/** LIVE_TESTS_RUN always; LIVE_TESTS_AGENT_ID and LIVE_TESTS_AGENT_NAME only for a subagent's run, the name when known. */
const labelExports = ({ run, agentId, agentName }: RunLabels): readonly string[] => [
  `LIVE_TESTS_RUN=${shellQuote(run)}`,
  ...(agentId === null ? [] : [`LIVE_TESTS_AGENT_ID=${shellQuote(agentId)}`]),
  ...(agentId === null || agentName === null ? [] : [`LIVE_TESTS_AGENT_NAME=${shellQuote(agentName)}`]),
]

const ownMark = (nonce: string) => {
  if (!NONCE.test(nonce)) throw new Error(`live-tests: nonce ${JSON.stringify(nonce)} is not alphanumeric`)
  return `@@test:${nonce} {`
}

/** The lines kept as events: the run's own marked lines; a custom emitter's plain `@@test {` too, for runner "events". */
const marks = (runner: Runner, nonce: string) => (runner === 'events' ? ['@@test {', ownMark(nonce)] : [ownMark(nonce)])

/**
 * One step as a Bash group: the runner in a subshell, its output kept whole in the log and
 * the run's `@@test` lines alone in the events file, then its exit code appended there as the
 * last event, and the group exiting with that code.
 */
export const bashCommand = ({ cwd, argv, runner, env, emittersDir, files, nonce, labels }: CommandSpec) => {
  const badName = Object.keys(env).find(name => !IDENTIFIER.test(name))
  if (badName !== undefined) throw new Error(`tests config: env name ${JSON.stringify(badName)} is not a variable name`)
  const exports = [
    `LIVE_TESTS_NONCE=${shellQuote(nonce)}`,
    ...labelExports(labels),
    ...injection(runner, emittersDir),
    ...Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`),
  ]
  const run = argv.map(shellQuote).join(' ')
  const events = shellQuote(files.events)
  const grep = `grep --line-buffered -a ${marks(runner, nonce).map(mark => `-e ${shellQuote(mark)}`).join(' ')}`
  return (
    `{ (cd ${shellQuote(cwd)} && export ${exports.join(' ')} && ${run} 2>&1 | tee ${shellQuote(files.log)} | ${grep} >> ${events}; exit "\${PIPESTATUS[0]}"); ` +
    `c=$?; echo "@@test:${nonce} {\\"event\\":\\"exit\\",\\"code\\":$c}" >> ${events}; (exit $c); }`
  )
}

const startEvent = (events: string, nonce: string) => `echo "@@test:${nonce} {\\"event\\":\\"start\\",\\"pid\\":$BASHPID}" >> ${shellQuote(events)}`

/**
 * The whole suite as one Bash command (one background task): its shell's pid noted first, so a
 * killed run can be told from a slow one, then the steps chained, stopping at the first that fails.
 */
export const suiteCommand = (steps: readonly CommandSpec[]) =>
  `(${[startEvent(steps[0]?.files.events ?? '/dev/null', steps[0]?.nonce ?? ''), ...steps.map(bashCommand)].join(' && ')})`
