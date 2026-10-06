import { expect, test } from 'claude-code/testing'

import { runProgress } from '../hooks/progress'

const PASS = '@@test {"event":"result","name":"a","outcome":"passed"}\n'
const FAIL = '@@test {"event":"result","name":"b","outcome":"failed","message":"m"}\n'
const exit = (code: number) => `@@test {"event":"exit","code":${code}}\n`

const CASES = [
  ['nothing written yet', ['', ''], { current: 0, isDone: false, isOk: false }],
  ['first step running', [PASS, ''], { current: 0, isDone: false, isOk: false }],
  ['second step started', [PASS + exit(0), PASS], { current: 1, isDone: false, isOk: false }],
  ['all steps passed', [PASS + exit(0), PASS + exit(0)], { current: 1, isDone: true, isOk: true }],
  ['first step failed, stops the run', [FAIL + exit(1), ''], { current: 0, isDone: true, isOk: false }],
  ['exit 0 with a failed result is not ok', [FAIL + exit(0), PASS + exit(0)], { current: 1, isDone: true, isOk: false }],
  ['an unfinished line is not read yet', [PASS + '@@test {"event":"ex', ''], { current: 0, isDone: false, isOk: false }],
] as const

for (const [name, texts, expected] of CASES) {
  test(`runProgress: ${name}`, () => {
    const { current, isDone, isOk } = runProgress(['one', 'two'], texts)
    expect({ current, isDone, isOk }).toEqual(expected)
  })
}

test('runProgress keeps each step state and exit code', () => {
  const { steps } = runProgress(['one', 'two'], [PASS + FAIL + exit(1), ''])
  expect(steps[0]?.state.counts).toEqual({ passed: 1, failed: 1, error: 0, skipped: 0 })
  expect(steps[0]?.exitCode).toBe(1)
  expect(steps[1]?.exitCode).toBeUndefined()
})

const START = '@@test {"event":"start","pid":4242}\n'

const PIDS = [
  ['the start event names the suite process', [START + PASS, ''], 4242],
  ['no start event yet', [PASS, ''], undefined],
] as const

for (const [name, texts, pid] of PIDS) {
  test(`runProgress pid: ${name}`, () => {
    expect(runProgress(['one', 'two'], texts).pid).toBe(pid)
  })
}

test('runProgress reads events marked with the run\'s nonce', () => {
  const marked = (text: string) => text.replaceAll('@@test {', '@@test:n0 {')
  const { steps, isDone } = runProgress(['one'], [marked(PASS + FAIL + exit(1))], 'n0')
  expect(steps[0]?.state.counts).toEqual({ passed: 1, failed: 1, error: 0, skipped: 0 })
  expect(isDone).toBe(true)
})
