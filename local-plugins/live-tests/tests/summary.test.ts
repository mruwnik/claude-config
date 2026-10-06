import { expect, test } from 'claude-code/testing'

import { emptyStep } from '../hooks/events'
import { NO_EVENTS_HINT, countsLine, summarize } from '../hooks/summary'

const passing = { ...emptyStep('unit'), counts: { passed: 412, failed: 0, error: 0, skipped: 2 } }
const failing = {
  ...emptyStep('unit'),
  counts: { passed: 3, failed: 1, error: 0, skipped: 0 },
  failures: [{ name: 'test_a.py::test_bad', outcome: 'failed', message: 'line\n'.repeat(50) }],
} as const

test('countsLine names only the non-zero outcomes', () => {
  expect(countsLine(passing.counts)).toBe('412 passed, 2 skipped')
})

test('a passing run is one line per step plus the log', () => {
  const text = summarize({ suite: 'unit', durationMs: 38_000, logPath: '/tmp/x.log', steps: [{ state: passing, exit: { code: 0, signal: null }, tail: [] }] })
  expect(text).toBe('Suite unit: PASSED in 38s\n✓ unit: 412 passed, 2 skipped\nFull log: /tmp/x.log')
})

test('a failing run lists failures with trimmed messages', () => {
  const text = summarize({ suite: 'unit', durationMs: 1_000, logPath: '/tmp/x.log', steps: [{ state: failing, exit: { code: 1, signal: null }, tail: [] }] })
  expect(text).toMatch(/^Suite unit: FAILED in 1s\n✗ unit: 3 passed, 1 failed \(exit 1\)\n\nFAILED test_a\.py::test_bad\n/)
  expect(text).toMatch(/… 20 more lines in the log/)
})

test('a step that dies before reporting shows its output tail', () => {
  const text = summarize({
    suite: 'engine',
    durationMs: 2_000,
    logPath: '/tmp/x.log',
    steps: [{ state: emptyStep('compile'), exit: { code: 2, signal: null }, tail: ['error: Unexpected token'] }],
  })
  expect(text).toMatch(/✗ compile: exit 2, no test results\nLast output:\nerror: Unexpected token/)
})

test('failures beyond the cap are counted, not listed', () => {
  const failures = Array.from({ length: 13 }, (_, i) => ({ name: `t${i}`, outcome: 'failed' as const, message: 'x' }))
  const state = { ...emptyStep('unit'), counts: { passed: 0, failed: 13, error: 0, skipped: 0 }, failures }
  const text = summarize({ suite: 'unit', durationMs: 0, logPath: '/l', steps: [{ state, exit: { code: 1, signal: null }, tail: [] }] })
  expect(text).toMatch(/… and 3 more failures/)
  expect(text).not.toMatch(/FAILED t10/)
})

test('a baseline that differs is mentioned', () => {
  const text = summarize({
    suite: 'unit',
    durationMs: 0,
    logPath: '/l',
    steps: [{ state: passing, exit: { code: 0, signal: null }, tail: [] }],
    baseline: { passed: 410, failed: 0, error: 0, skipped: 2 },
  })
  expect(text).toMatch(/Last run: 410 passed, 2 skipped/)
})

test('a passing step without events shows the end of its output', () => {
  const text = summarize({
    suite: 'mod',
    durationMs: 1_000,
    logPath: '/l',
    steps: [{ state: emptyStep('mod'), exit: { code: 0, signal: null }, tail: ['(pass) x', '', ' 52 pass', ' 0 fail', 'Ran 52 tests across 5 files.', ''] }],
  })
  expect(text).toBe('Suite mod: PASSED in 1s\n✓ mod: exit 0, no @@test events; last output:\n 52 pass\n 0 fail\nRan 52 tests across 5 files.\n' + NO_EVENTS_HINT + '\nFull log: /l')
})

test('a run where some step reported tests gets no hint', () => {
  const tested = { ...emptyStep('unit'), counts: { passed: 2, failed: 0, error: 0, skipped: 0 } }
  const text = summarize({
    suite: 'all',
    durationMs: 1_000,
    logPath: '/l',
    steps: [
      { state: emptyStep('build'), exit: { code: 0, signal: null }, tail: ['built'] },
      { state: tested, exit: { code: 0, signal: null }, tail: [] },
    ],
  })
  expect(text).not.toContain(NO_EVENTS_HINT)
})

test('a summary says how many failures were already reported during the run', () => {
  const text = summarize({ suite: 'unit', durationMs: 1_000, logPath: '/l', steps: [{ state: failing, exit: { code: 1, signal: null }, tail: [] }], reportedFailures: 1 })
  expect(text).toMatch(/^Suite unit: FAILED in 1s\n✗ unit: 3 passed, 1 failed \(exit 1\)\n1 failure was already reported during the run\.\n\nFAILED /)
})
