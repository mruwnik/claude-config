import { expect, test } from 'claude-code/testing'

import { bashCommand, shellQuote, suiteCommand } from '../hooks/command'

const QUOTES = [
  ['plain', "'plain'"],
  ["it's", "'it'\\''s'"],
  ['$(rm -rf /)', "'$(rm -rf /)'"],
] as const

for (const [raw, quoted] of QUOTES) {
  test(`shellQuote ${raw}`, () => {
    expect(shellQuote(raw)).toBe(quoted)
  })
}

const FILES = { log: '/l.log', events: '/e.log' }
const NONCE = 'n0'
const LABELS = { run: 'r0', agentId: null, agentName: null }
const grep = (patterns: readonly string[]) => `grep --line-buffered -a ${patterns.map(p => `-e '${p}'`).join(' ')}`
const tail = (patterns: readonly string[]) =>
  ` 2>&1 | tee '/l.log' | ${grep(patterns)} >> '/e.log'; exit "\${PIPESTATUS[0]}"); c=$?; echo "@@test:n0 {\\"event\\":\\"exit\\",\\"code\\":$c}" >> '/e.log'; (exit $c); }`
const OWN = ['@@test:n0 {']

const COMMANDS = [
  [
    { cwd: '/p', argv: ['uv', 'run', 'pytest', '-k', 'a b'], runner: 'pytest', env: {} },
    `{ (cd '/p' && export LIVE_TESTS_NONCE='n0' LIVE_TESTS_RUN='r0' PYTHONPATH='/em'"\${PYTHONPATH:+:$PYTHONPATH}" PYTEST_ADDOPTS='-p live_tests_pytest'"\${PYTEST_ADDOPTS:+ $PYTEST_ADDOPTS}" && 'uv' 'run' 'pytest' '-k' 'a b'${tail(OWN)}`,
  ],
  [
    { cwd: '/p', argv: ['npm', 'test'], runner: 'node-test', env: { CI: '1' } },
    `{ (cd '/p' && export LIVE_TESTS_NONCE='n0' LIVE_TESTS_RUN='r0' LIVE_TESTS_PREV_NODE_OPTIONS="\${NODE_OPTIONS-}" NODE_OPTIONS='--test-reporter=/em/node-reporter.mjs --test-reporter-destination=stdout --test-reporter=spec --test-reporter-destination=stderr'"\${NODE_OPTIONS:+ $NODE_OPTIONS}" CI='1' && 'npm' 'test'${tail(OWN)}`,
  ],
  [{ cwd: '/p', argv: ['make', 'check'], runner: 'events', env: {} }, `{ (cd '/p' && export LIVE_TESTS_NONCE='n0' LIVE_TESTS_RUN='r0' && 'make' 'check'${tail(['@@test {', '@@test:n0 {'])}`],
] as const

test('bashCommand keeps the inherited NODE_OPTIONS for the reporter to restore, before setting its own', () => {
  const command = bashCommand({ cwd: '/p', argv: ['node', '--test'], runner: 'node-test', env: {}, emittersDir: '/em', files: FILES, nonce: NONCE, labels: LABELS })
  const kept = command.indexOf('LIVE_TESTS_PREV_NODE_OPTIONS="${NODE_OPTIONS-}"')
  expect(kept).toBeGreaterThan(0)
  expect(kept).toBeLessThan(command.indexOf(' NODE_OPTIONS='))
})

for (const [step, expected] of COMMANDS) {
  test(`bashCommand ${step.runner}`, () => {
    expect(bashCommand({ ...step, emittersDir: '/em', files: FILES, nonce: NONCE, labels: LABELS })).toBe(expected)
  })
}

test('bashCommand rejects env names that are not identifiers', () => {
  expect(() => bashCommand({ cwd: '/p', argv: ['x'], runner: 'events', env: { 'A;rm': '1' }, emittersDir: '/em', files: FILES, nonce: NONCE, labels: LABELS })).toThrow()
})

test('suiteCommand chains steps so a failing step stops the rest, in a subshell', () => {
  const step = (n: number) => ({ cwd: '/p', argv: [`s${n}`], runner: 'events' as const, env: {}, emittersDir: '/em', files: { log: `/${n}.log`, events: `/${n}.e` }, nonce: NONCE, labels: LABELS })
  const command = suiteCommand([step(1), step(2)])
  expect(command.endsWith(` && ${bashCommand(step(1))} && ${bashCommand(step(2))})`)).toBe(true)
})

test('suiteCommand first notes the suite process in the first step\'s events, for the poller to tell a killed run', () => {
  const step = { cwd: '/p', argv: ['make'], runner: 'events', env: {}, emittersDir: '/em', nonce: NONCE, labels: LABELS } as const
  const command = suiteCommand([{ ...step, files: FILES }, { ...step, files: { log: '/l2.log', events: '/e2.log' } }])
  expect(command.startsWith(`(echo "@@test:n0 {\\"event\\":\\"start\\",\\"pid\\":$BASHPID}" >> '/e.log' && { (cd '/p'`)).toBe(true)
})

const LABELLED = [
  [{ run: 'toolu_1', agentId: null, agentName: null }, `LIVE_TESTS_RUN='toolu_1'`],
  [{ run: 'toolu_1', agentId: 'a1', agentName: null }, `LIVE_TESTS_RUN='toolu_1' LIVE_TESTS_AGENT_ID='a1'`],
  [{ run: 'toolu_1', agentId: 'a1', agentName: "bob's" }, `LIVE_TESTS_RUN='toolu_1' LIVE_TESTS_AGENT_ID='a1' LIVE_TESTS_AGENT_NAME='bob'\\''s'`],
  [{ run: "r'$(x)", agentId: '$(rm -rf /)', agentName: 'a b' }, `LIVE_TESTS_RUN='r'\\''$(x)' LIVE_TESTS_AGENT_ID='$(rm -rf /)' LIVE_TESTS_AGENT_NAME='a b'`],
] as const

for (const [labels, expected] of LABELLED) {
  test(`bashCommand labels the run's processes: agent ${labels.agentId ?? 'main'}, name ${labels.agentName ?? 'none'}`, () => {
    const command = bashCommand({ cwd: '/p', argv: ['make'], runner: 'events', env: {}, emittersDir: '/em', files: FILES, nonce: NONCE, labels })
    expect(command.startsWith(`{ (cd '/p' && export LIVE_TESTS_NONCE='n0' ${expected} && 'make'`)).toBe(true)
  })
}
