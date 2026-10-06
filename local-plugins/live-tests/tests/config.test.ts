import { expect, test } from 'claude-code/testing'

import { configSource, detectConfig, mergeConfigs, normalizeConfig, noConfigReply, stepArgv } from '../hooks/config'

test('normalizeConfig turns argv shorthand into one step', () => {
  expect(normalizeConfig({ suites: { unit: { argv: ['pytest'], runner: 'pytest' } } })).toEqual({
    default: 'unit',
    suites: { unit: { steps: [{ argv: ['pytest'], runner: 'pytest' }] } },
  })
})

const INVALID = [
  { suites: { unit: {} } },
  { suites: { unit: { argv: 'pytest' } } },
  { suites: { unit: { steps: [{ argv: [] }] } } },
  { suites: { unit: { argv: ['x'], runner: 'mocha' } } },
  { suites: {} },
  { default: 'missing', suites: { unit: { argv: ['x'] } } },
  'nope',
]

for (const raw of INVALID) {
  test(`normalizeConfig rejects ${JSON.stringify(raw)}`, () => {
    expect(() => normalizeConfig(raw)).toThrow()
  })
}

test('normalizeConfig keeps a suite\'s failureNotices', () => {
  expect(normalizeConfig({ suites: { world: { argv: ['x'], failureNotices: 'each' } } }).suites.world).toEqual({ failureNotices: 'each', steps: [{ argv: ['x'] }] })
})

test('normalizeConfig keeps a suite\'s concurrency', () => {
  expect(normalizeConfig({ suites: { engine: { argv: ['x'], concurrency: 'any' } } }).suites.engine).toEqual({ concurrency: 'any', steps: [{ argv: ['x'] }] })
})

const MESSAGES: readonly (readonly [unknown, string])[] = [
  [{ suites: { unit: {} } }, 'suite "unit" needs "argv" (one command, e.g. ["uv", "run", "pytest"]) or "steps"'],
  [{ suites: { unit: { argv: 'npm test' } } }, 'suite "unit": "argv" must be a non-empty list of strings, e.g. ["npm", "test", "--"]'],
  [{ suites: { unit: { steps: [{ argv: ['a'] }, { argv: [] }] } } }, 'suite "unit", step 2: "argv" must be a non-empty list of strings'],
  [{ suites: { unit: { argv: ['x'], runner: 'mocha' } } }, 'suite "unit": "runner" is "mocha"; allowed: pytest, node-test, events'],
  [{ suites: { unit: { command: 'pytest' } } }, 'suite "unit": unknown field "command"; allowed: description, cwd, env, timeoutMs, failureNotices, concurrency, argv, runner, steps'],
  [{ suites: { unit: { argv: ['x'], concurrency: 'parallel' } } }, 'suite "unit": "concurrency" is "parallel"; allowed: args, exclusive, any'],
  [{ suites: { unit: { argv: ['x'], failureNotices: 'always' } } }, 'suite "unit": "failureNotices" is "always"; allowed: auto, each, first, off'],
  [{ suites: { unit: { steps: [{ argv: ['x'], cmd: 'y' }] } } }, 'suite "unit", step 1: unknown field "cmd"; allowed: argv, runner, cwd, env, label, acceptsArgs'],
  [{ suites: { unit: { argv: ['x'], timeoutMs: '10m' } } }, 'suite "unit": "timeoutMs" must be a positive number of milliseconds'],
  [{ suites: { unit: { argv: ['x'], env: { CI: 1 } } } }, 'suite "unit": "env" must map names to strings, e.g. {"CI": "1"}'],
  [{ default: 'missing', suites: { unit: { argv: ['x'] } } }, '"default" is "missing", but the suites are: unit'],
  ['nope', 'needs a "suites" object, e.g. {"suites": {"unit": {"argv": ["pytest"], "runner": "pytest"}}}'],
]

for (const [raw, message] of MESSAGES) {
  test(`normalizeConfig explains ${JSON.stringify(raw)}`, () => {
    expect(() => normalizeConfig(raw, () => '/p/.claude/tests.json')).toThrow(`tests config error in /p/.claude/tests.json: ${message}`)
  })
}

test('configSource blames the file a suite comes from', () => {
  const paths = { shared: '/p/.claude/tests.json', local: '/p/.claude/tests.local.json' }
  const source = configSource({ suites: { unit: {} } }, { suites: { e2e: {} } }, paths)
  expect([source('unit'), source('e2e'), source(undefined)]).toEqual([paths.shared, paths.local, `${paths.shared} or ${paths.local}`])
})

test('configSource names only the files that exist', () => {
  const paths = { shared: '/p/.claude/tests.json', local: '/p/.claude/tests.local.json' }
  expect(configSource(undefined, { suites: {} }, paths)(undefined)).toBe(paths.local)
})

test('noConfigReply says what to write and where', () => {
  expect(noConfigReply('/p')).toBe(
    'No test suites are configured or detected in /p (looked for pytest in pyproject.toml or pytest.ini, and a "test" script in package.json).\n' +
      'To set it up, write /p/.claude/tests.json, for example:\n' +
      '{"suites": {"unit": {"argv": ["uv", "run", "pytest"], "runner": "pytest"}}}\n' +
      'then call run_tests again. The live-tests:setup-tests skill has templates for other projects (node --test, build steps, subfolders, other test runners).',
  )
})

test('mergeConfigs lets local suites and default win', () => {
  const shared = { suites: { unit: { argv: ['pytest'] }, e2e: { argv: ['e2e'] } } }
  const local = { default: 'e2e', suites: { unit: { argv: ['uv', 'run', 'pytest'] } } }
  expect(mergeConfigs(shared, local)).toEqual({
    default: 'e2e',
    suites: { unit: { argv: ['uv', 'run', 'pytest'] }, e2e: { argv: ['e2e'] } },
  })
})

const DETECTIONS = [
  [{ pyproject: '[tool.pytest.ini_options]\n', hasUvLock: true }, { argv: ['uv', 'run', 'pytest'], runner: 'pytest' }],
  [{ pyproject: '[project]\ndependencies=["pytest"]', hasUvLock: false }, { argv: ['python', '-m', 'pytest'], runner: 'pytest' }],
  [{ hasPytestIni: true }, { argv: ['python', '-m', 'pytest'], runner: 'pytest' }],
  [{ packageJson: '{"scripts":{"test":"node --test test/*.test.mjs"}}' }, { argv: ['npm', 'test', '--'], runner: 'node-test' }],
  [{ packageJson: '{"scripts":{"test":"vitest run"}}' }, { argv: ['npm', 'test', '--'], runner: 'events' }],
] as const

for (const [files, suite] of DETECTIONS) {
  test(`detectConfig ${JSON.stringify(files)}`, () => {
    expect(detectConfig(files)).toEqual({ suites: { default: suite } })
  })
}

const NOTHING = [{}, { packageJson: '{"scripts":{}}' }, { packageJson: 'not json' }, { pyproject: '[project]\n' }]

for (const files of NOTHING) {
  test(`detectConfig finds nothing in ${JSON.stringify(files)}`, () => {
    expect(detectConfig(files)).toBeUndefined()
  })
}

const ARGS = [
  [{ argv: ['pytest'] }, true, ['-k', 'x'], ['pytest', '-k', 'x']],
  [{ argv: ['build'] }, false, ['-k', 'x'], ['build']],
  [{ argv: ['build'], acceptsArgs: true }, false, ['-k', 'x'], ['build', '-k', 'x']],
  [{ argv: ['pytest'], acceptsArgs: false }, true, ['-k', 'x'], ['pytest']],
] as const

for (const [step, isLast, args, expected] of ARGS) {
  test(`stepArgv ${JSON.stringify([step, isLast])}`, () => {
    expect(stepArgv(step, isLast, args)).toEqual(expected)
  })
}

