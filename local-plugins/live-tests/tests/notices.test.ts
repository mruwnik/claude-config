import { expect, test } from 'claude-code/testing'

import type { Failure, StepState } from '../hooks/events'
import { freshFailures, noticeBatch, noticeMode, noticeText, parseNoticeMode } from '../hooks/notices'
import type { NoticeLog, NoticeMode } from '../hooks/notices'

const failed = (name: string, message = 'boom'): Failure => ({ name, outcome: 'failed', message })

const step = (failures: readonly Failure[]): StepState => ({
  label: 'unit',
  planned: 10,
  counts: { passed: 0, failed: failures.length, error: 0, skipped: 0 },
  failures,
})

test('freshFailures keeps failed tests not yet reported, once each, leaving errors to the summary', () => {
  const steps = [step([failed('t::a'), { name: 't::e', outcome: 'error', message: 'x' }, failed('t::b'), failed('t::b', 'again')]), step([failed('t::a')])]
  expect(freshFailures(steps, ['1:t::a']).map(f => f.id)).toEqual(['1:t::b', '2:t::a'])
})

const NONE: NoticeLog = { reported: [], sentAt: null }

const BATCHES: readonly (readonly [string, NoticeMode, number, NoticeLog, number])[] = [
  ['each sends the first failure at once', 'each', 5_000, NONE, 2],
  ['each holds failures inside the 60s window', 'each', 30_000, { reported: ['1:t::z'], sentAt: 10_000 }, 0],
  ['each batches failures once 60s have passed', 'each', 70_000, { reported: ['1:t::z'], sentAt: 10_000 }, 2],
  ['first sends one notice', 'first', 5_000, NONE, 2],
  ['first sends nothing after its notice', 'first', 500_000, { reported: ['1:t::z'], sentAt: 10_000 }, 0],
  ['off sends nothing', 'off', 500_000, NONE, 0],
  ['auto holds failures before 120s', 'auto', 119_999, NONE, 0],
  ['auto releases held failures at 120s', 'auto', 120_000, NONE, 2],
  ['auto throttles like each after 120s', 'auto', 150_000, { reported: ['1:t::z'], sentAt: 120_000 }, 0],
  ['auto batches like each after 120s', 'auto', 180_000, { reported: ['1:t::z'], sentAt: 120_000 }, 2],
]

for (const [name, mode, now, log, count] of BATCHES) {
  test(`noticeBatch: ${name}`, () => {
    expect(noticeBatch({ mode, now, startedAt: 0, log, steps: [step([failed('t::a'), failed('t::b')])] })).toHaveLength(count)
  })
}

test('noticeBatch sends nothing when no failure is new', () => {
  expect(noticeBatch({ mode: 'each', now: 500_000, startedAt: 0, log: { reported: ['1:t::a'], sentAt: null }, steps: [step([failed('t::a')])] })).toEqual([])
})

test('noticeBatch under auto sends nothing early for a run that ends before 120s', () => {
  const polls = [1_000, 30_000, 60_000, 90_000, 119_500]
  const sent = polls.flatMap(now => noticeBatch({ mode: 'auto', now, startedAt: 0, log: NONE, steps: [step([failed('t::a')])] }))
  expect(sent).toEqual([])
})

test('noticeBatch counts the 120s from the run start', () => {
  expect(noticeBatch({ mode: 'auto', now: 130_000, startedAt: 20_000, log: NONE, steps: [step([failed('t::a')])] })).toEqual([])
})

const MODES: readonly (readonly [NoticeMode | undefined, NoticeMode | undefined, NoticeMode])[] = [
  [undefined, undefined, 'auto'],
  [undefined, 'off', 'off'],
  ['each', 'off', 'each'],
  ['off', 'each', 'off'],
  ['first', undefined, 'first'],
]

for (const [arg, suite, mode] of MODES) {
  test(`noticeMode: tool arg ${arg} over suite ${suite} is ${mode}`, () => {
    expect(noticeMode(arg, suite)).toBe(mode)
  })
}

const PARSED = [
  ['auto', 'auto'],
  ['each', 'each'],
  ['first', 'first'],
  ['off', 'off'],
  ['all', undefined],
  [true, undefined],
  [undefined, undefined],
] as const

for (const [raw, mode] of PARSED) {
  test(`parseNoticeMode ${JSON.stringify(raw)}`, () => {
    expect(parseNoticeMode(raw)).toBe(mode)
  })
}

test('noticeText names the run, its progress, each new failure and the log', () => {
  const text = noticeText({ label: 'world [w1]', progress: '2/34 5%', failures: [failed('t::a', 'assert 1 == 2\n'), failed('t::b')], logPath: '/l' })
  expect(text).toBe(
    'Suite world [w1]: 2 new failures so far (2/34 5%).\n\nFAILED t::a\nassert 1 == 2\n\nFAILED t::b\nboom\n\nFull log: /l\nThe run continues; the full summary comes when it ends.',
  )
})

test('noticeText trims a long traceback as the summary does', () => {
  const message = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  const text = noticeText({ label: 'world', progress: '1/34 2%', failures: [failed('t::a', message)], logPath: '/l' })
  expect(text).toMatch(/^Suite world: 1 new failure so far \(1\/34 2%\)\.\n\nFAILED t::a\nline 0\n[\s\S]*… \d+ more lines in the log\n\nFull log: \/l\n/)
})
