import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const CONFIG = JSON.stringify({ suites: { unit: { argv: ['python', '-m', 'pytest'], runner: 'pytest' } } })

const EVENTS = [
  'collected 3 items',
  '@@test {"event": "plan", "total": 3}',
  '.@@test {"event": "result", "name": "t::a", "outcome": "passed", "message": null}',
  'F@@test {"event": "result", "name": "t::b", "outcome": "failed", "message": "assert 1 == 2"}',
  '.@@test {"event": "result", "name": "t::c", "outcome": "passed", "message": null}',
  '@@test {"event":"exit","code":1}',
  '',
].join('\n')

const SUMMARY = /Suite unit: FAILED in \d+s\n✗ unit: 2 passed, 1 failed \(exit 1\)\n\nFAILED t::b\nassert 1 == 2\n/

type Bash = { command: string; run_in_background?: boolean }

/**
 * A project at /proj whose Bash calls behave like a pytest run writing its events file.
 * `backgroundTaskId` makes Bash answer as a command moved to the background (asked, or timed out).
 */
const EVENTS_FILE = /> '([^']+\.events)'/g
const LOG_FILE = /tee '([^']+\.log)'/g

type WorldOptions = { config?: string; isBashRejected?: boolean }

const world = (on: On, calls: Bash[], backgroundTaskId?: string, { config = CONFIG, isBashRejected = false }: WorldOptions = {}) => {
  const rows: { type: string; text?: string }[][] = []
  const descriptions: string[] = []
  const files = new Map([
    ['/proj/.claude/tests.json', config],
    ['/wt/a/.claude/tests.json', config],
  ])
  const clock = mock.clock(on)
  mock.store(on)
  on('session.root', () => ({ value: '/proj' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // The engine's own band and footer modes, drawn as the engine would from the props it gets.
  on('ui.render', { component: 'AbovePrompt' }, (_$, e) => {
    const { Box } = _$.ui.resolve(e)
    return <Box />
  })
  // A mode spelled `+text` stands for what another plugin beneath adds: a Text of its own beside the modes;
  // `>text` for a column it asks to keep last (agent-usage's), a Box keyed `trailing:agent-usage`.
  on('ui.render', { component: 'SessionMode' }, (_$, e) => {
    const { Box, Text } = _$.ui.resolve(e)
    const modes = e.props.modes.filter(mode => !mode.startsWith('+') && !mode.startsWith('>'))
    const added = e.props.modes.filter(mode => mode.startsWith('+')).map(mode => mode.slice(1))
    const last = e.props.modes.filter(mode => mode.startsWith('>')).map(mode => mode.slice(1))
    if (added.length === 0 && last.length === 0) return <Text>{modes.join(' & ')}</Text>
    return (
      <Box flexDirection="row">
        <Text>{modes.join(' & ')}</Text>
        {added.map(text => (
          <Text key={text}>{text}</Text>
        ))}
        {last.length > 0 && (
          <Box key="trailing:agent-usage" flexDirection="column">
            {last.map(text => (
              <Text key={text}>{text}</Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('tool.register', (_$, e) => {
    descriptions.push(e.description)
    return { value: { tool: `mcp__live-tests__${e.name}` } }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('session.append', (_$, e, next) => {
    rows.push(e.message.content)
    return next(e)
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    calls.push({ command: e.command, run_in_background: e.run_in_background })
    if (isBashRejected) throw new Error('Bash went away')
    // A command moved to the background is still running: its exit line comes later.
    const written = backgroundTaskId === undefined ? EVENTS : EVENTS.replace(/@@test \{"event":"exit".*\n/, '')
    const named = (pattern: RegExp) => [...e.command.matchAll(pattern)].map(match => match[1] ?? '')
    named(EVENTS_FILE).forEach(events => files.set(events, written))
    named(LOG_FILE).forEach(log => files.set(log, 'collected 3 items\nFAILED t::b\n'))
    return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId } }
  })
  return { files, rows, clock, descriptions }
}

/** The background commands end: their exit lines land, then Claude Code's notification rows. */
const complete = (files: Map<string, string>) =>
  [...files.keys()].filter(path => path.endsWith('.events')).forEach(path => files.set(path, EVENTS))

const notification = (taskId: string) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>Background command completed (exit code 1)</summary>\n</task-notification>`

/** Raises the row as Claude Code would; the test's own hook records what reached it, the store beneath being absent here. */
const append = ($: Engine, text: string) =>
  $.session
    .append({
      message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text }] },
      door: 'prompt',
      origin: { kind: 'task-notification' },
      uuid: 'row-1',
    })
    .catch(() => undefined)

/** As Claude Code delivers a notification into a running turn: an attachment row, kept as made. */
const deliver = ($: Engine, text: string) =>
  $.session
    .append({
      message: { type: 'attachment', name: 'queued_command', isMeta: true, content: [{ type: 'text', text }] },
      door: 'delivery',
      origin: { kind: 'task-notification' },
      uuid: 'row-2',
    })
    .catch(() => undefined)

const textOf = (content: readonly { type: string; text?: string }[]) => content.map(b => b.text ?? '').join('\n')

test('a foreground run is one Bash command and answers with the summary', async ($, on) => {
  const calls: Bash[] = []
  const { files } = world(on, calls)
  const called = await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit' })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.command).toMatch(/^\(echo [^&]+ && \{ \(cd '\/proj' && export LIVE_TESTS_NONCE='[^']+' LIVE_TESTS_RUN='toolu_[^']+' PYTHONPATH=/)
  expect(calls[0]?.run_in_background).toBeUndefined()
  expect(called.result).toMatch(SUMMARY)
  expect(files.get('/proj/.claude/live-tests/.gitignore')).toBe('*\n')
})

test('a background run returns at once and its summary rides on the task notification', async ($, on) => {
  const calls: Bash[] = []
  const { files, rows } = world(on, calls, 'bg1')
  const called = await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  expect(calls[0]?.run_in_background).toBe(true)
  expect(called.result).toMatch(/background task bg1/)
  complete(files)
  await append($, notification('bg1'))
  expect(textOf(rows[0] ?? [])).toMatch(SUMMARY)
})

// The summary row the mod appends after a mid-turn notification is the mod's own `$.session.append`,
// which this kit does not route through a test's hooks; it was checked in a live session instead.
test('a notification delivered mid-turn is passed on as made, the engine keeping attachment rows', async ($, on) => {
  const { files, rows } = world(on, [], 'bg5')
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  complete(files)
  await deliver($, notification('bg5'))
  expect(rows).toEqual([[{ type: 'text', text: notification('bg5') }]])
})

test('a foreground run that Bash moves to the background is followed the same way', async ($, on) => {
  const { files, rows } = world(on, [], 'bg2')
  const called = await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit' })
  expect(called.result).toMatch(/moved to the background as task bg2/)
  complete(files)
  await append($, notification('bg2'))
  expect(textOf(rows[0] ?? [])).toMatch(SUMMARY)
})

test('other notifications are left alone', async ($, on) => {
  const { rows } = world(on, [], 'bg3')
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  await append($, notification('other'))
  expect(textOf(rows[0] ?? [])).toBe(notification('other'))
})

test('a suite already running in the background is not started twice', async ($, on) => {
  const calls: Bash[] = []
  world(on, calls, 'bg4')
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  const again = await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  expect(calls).toHaveLength(1)
  expect(again.result).toMatch(/already running for you \(background task bg4, started 0s ago; results so far: [^;]*; log \/proj\/\.claude\/live-tests\/unit-\d+-\w+-1\.log\)\. It is your own run/)
  expect(again.result).not.toMatch(/stop it first/)
})

const FIXER = [{ id: 'f2', status: 'running', name: 'fixer-2', description: 'fix the engine' }]

test('a refusal names the agent that holds the run, when it started and its log, and says not to stop it', async ($, on) => {
  world(on, [], 'bg12')
  on('agent.list', () => ({ value: FIXER }))
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true, args: ['-k', 'breathe'], agentId: 'f2' })
  const again = await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true, args: ['-k', 'breathe'] })
  expect(again.result).toMatch(
    /^Suite unit with args \["-k","breathe"\] is already running for \[fixer-2\] \(background task bg12, started 0s ago; results so far: [^;]*; log \/proj\/\.claude\/live-tests\/unit-\d+-\w+-1\.log\)\. It belongs to \[fixer-2\], so don't stop it/,
  )
})

const LABELLED = [
  ['main', undefined, /export LIVE_TESTS_NONCE='[^']+' LIVE_TESTS_RUN='toolu_[^']+' PYTHONPATH=/],
  ['a subagent', 'f2', /export LIVE_TESTS_NONCE='[^']+' LIVE_TESTS_RUN='toolu_[^']+' LIVE_TESTS_AGENT_ID='f2' LIVE_TESTS_AGENT_NAME='fixer-2' PYTHONPATH=/],
] as const

for (const [who, agentId, exported] of LABELLED) {
  test(`a run started by ${who} labels its suite processes with the run and the agent`, async ($, on) => {
    const calls: Bash[] = []
    world(on, calls, 'bg13')
    on('agent.list', () => ({ value: FIXER }))
    await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true, agentId })
    expect(calls[0]?.command).toMatch(exported)
  })
}

const config = (concurrency: string) => JSON.stringify({ suites: { unit: { argv: ['python', '-m', 'pytest'], runner: 'pytest', concurrency } } })

const CONCURRENT = [
  ['identical args under the default', CONFIG, [['-k', 'a'], ['-k', 'a']], 1],
  ['other args under the default', CONFIG, [['-k', 'a'], ['-k', 'b']], 2],
  ['other args when exclusive', config('exclusive'), [['-k', 'a'], ['-k', 'b']], 1],
  ['identical args under any', config('any'), [['-k', 'a'], ['-k', 'a']], 2],
] as const

for (const [name, text, argsList, bashCalls] of CONCURRENT) {
  test(`two calls at once: ${name} start ${bashCalls} Bash command(s), each with its own files`, async ($, on) => {
    const calls: Bash[] = []
    world(on, calls, 'bg13', { config: text })
    await Promise.all(argsList.map(args => $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true, args: [...args] })))
    expect(calls).toHaveLength(bashCalls)
    expect(new Set(calls.flatMap(call => [...call.command.matchAll(EVENTS_FILE)].map(match => match[1]))).size).toBe(bashCalls)
  })
}

test('a run whose suite process is gone without an exit is settled and no longer blocks', async ($, on) => {
  const calls: Bash[] = []
  const { files, clock } = world(on, calls, 'bg14')
  await startSession($)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  const events = [...files.keys()].filter(path => path.endsWith('.events'))
  events.forEach(path => files.set(path, '@@test {"event":"start","pid":4242}\n'))
  files.set('/proc/self', '')
  files.set('/proc/4242', '')
  await clock.advance(600)
  files.delete('/proc/4242')
  await clock.advance(6_000)
  expect(await footerModes($)).toMatch(/✗ unit/)
  const again = await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  expect(calls).toHaveLength(2)
  expect(again.result).toMatch(/started as background task/)
})

test('a run whose Bash call rejects leaves no running record behind', async ($, on) => {
  world(on, [], undefined, { isBashRejected: true })
  await startSession($)
  const first = await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit' })
  expect(first.result).toMatch(/^The Bash call failed: /)
  expect(await footerModes($)).toBe('focus')
})

test('run_tests names the suites when asked for one that does not exist', async ($, on) => {
  world(on, [])
  const called = await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'nope' })
  expect(called.result).toMatch(/No suite "nope"[\s\S]*- unit: python -m pytest/)
})

test('run_tests passes args to the last step, quoted', async ($, on) => {
  const calls: Bash[] = []
  world(on, calls)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', args: ['-k', 'a or $(id)'] })
  expect(calls[0]?.command).toContain(`'python' '-m' 'pytest' '-k' 'a or $(id)'`)
})

/** Starts the session as the REPL would, which starts the mod's poller. */
const startSession = ($: Engine) => $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

const BAND_PROPS = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }

/** A drawn node's text, its inline elements' (a line's coloured stretches) included. */
const flatText = (node: unknown): string =>
  typeof node === 'string' ? node : ((node as { children?: unknown[] } | undefined)?.children ?? []).map(flatText).join('')

/** The lines a drawn tree shows: each outermost Text, whole. */
const linesOf = (node: unknown): string[] => {
  if (typeof node === 'string') return [node]
  const element = node as { type?: string; children?: unknown[] } | undefined
  if (element?.type === 'Text') return [flatText(element)]
  return (element?.children ?? []).flatMap(linesOf)
}

/** What a site draws on the terminal, its texts joined. */
const drawn = async ($: Engine, site: { component: 'AbovePrompt'; props: typeof BAND_PROPS } | { component: 'SessionMode'; props: { modes: string[] } }) => {
  const ui = await $.ui.mount({ plugin: 'live-tests', surface: 'terminal', ...site })
  const lines = linesOf(await ui.find({}))
  await ui.unmount()
  return lines.join(' ')
}

const bandText = ($: Engine) => drawn($, { component: 'AbovePrompt', props: BAND_PROPS })
const footerModes = ($: Engine) => drawn($, { component: 'SessionMode', props: { modes: ['focus'] } })

/** The footer's rows on the terminal, one text each. */
const footerRows = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: 'live-tests', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
  const lines = linesOf(await ui.find({}))
  await ui.unmount()
  return lines
}

const chooseView = ($: Engine, args: string) =>
  $.command.run({ command: 'tests-view', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

test('a notification queued as a prompt neither clears the band nor loses the summary', async ($, on) => {
  const { files, rows, clock } = world(on, [], 'bg6')
  on('prompt.submit', () => ({ text: 'unused' }))
  await startSession($)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  complete(files)
  await clock.advance(600)
  await $.prompt.submit({ text: notification('bg6'), wait: false, origin: { kind: 'task-notification' } }).catch(() => undefined)
  const footer = await footerModes($)
  await append($, notification('bg6'))
  expect(footer).toMatch(/✗ unit 2 ✓  1 ✗/)
  expect(textOf(rows[0] ?? [])).toMatch(SUMMARY)
})

test('a prompt the person types clears finished runs from the band', async ($, on) => {
  const { files, clock } = world(on, [], 'bg7')
  on('prompt.submit', () => ({ text: 'unused' }))
  await startSession($)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  complete(files)
  await clock.advance(600)
  await $.prompt.submit({ text: 'next thing', wait: false, origin: { kind: 'composer' } }).catch(() => undefined)
  expect(await footerModes($)).toBe('focus')
})

test('results show in the footer by default, under the modes already there', async ($, on) => {
  const { files, clock } = world(on, [], 'bg8')
  await startSession($)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  complete(files)
  await clock.advance(600)
  expect(await footerModes($)).toMatch(/^focus ✗ unit 2 ✓  1 ✗ \d+s$/)
  expect(await bandText($)).toBe('')
})

test('the band and pane show counts as symbols too: passed green, failed red', async ($, on) => {
  world(on, [])
  await startSession($)
  await chooseView($, 'band')
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit' })
  expect(await bandText($)).toMatch(/^✗ unit · 2 ✓  1 ✗ · \d+s +✗ t::b$/)
  const ui = await $.ui.mount({ plugin: 'live-tests', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  expect(texts.filter(t => t.props.color === 'success').map(t => t.text)).toEqual(['2 ✓'])
  expect(texts.filter(t => t.props.color === 'error').map(t => t.text)).toEqual(['✗ unit', '1 ✗', '  ✗ t::b'])
})

const BAND_VIEWS = ['band', 'band-right'] as const

for (const chosen of BAND_VIEWS) {
  test(`/tests-view ${chosen} moves results from the footer to the band`, async ($, on) => {
    const { files, clock } = world(on, [], 'bg9')
    await startSession($)
    await chooseView($, chosen)
    await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
    complete(files)
    await clock.advance(600)
    expect(await bandText($)).toMatch(/✗ unit/)
    expect(await footerModes($)).toBe('focus')
  })
}

test('/tests-view with no valid view says how to use it', async ($, on) => {
  world(on, [])
  await startSession($)
  const answer = await chooseView($, 'sideways')
  expect(answer.text).toMatch(/Usage: \/tests-view footer\|band\|band-right\|pane \(now: footer\)/)
})

test('cwd runs the suite in that folder, its files kept there', async ($, on) => {
  const calls: Bash[] = []
  const { files } = world(on, calls)
  const called = await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', cwd: '/wt/a' })
  expect(calls[0]?.command).toMatch(/^\(echo [^&]+ && \{ \(cd '\/wt\/a' && /)
  expect(called.result).toMatch(/Full log: \/wt\/a\/\.claude\/live-tests\//)
  expect(files.get('/wt/a/.claude/live-tests/.gitignore')).toBe('*\n')
})

test('a worktree without a local config falls back to the session root one', async ($, on) => {
  const calls: Bash[] = []
  const { files } = world(on, calls)
  files.set('/proj/.claude/tests.local.json', JSON.stringify({ suites: { unit: { argv: ['uv', 'run', 'pytest'], runner: 'pytest' } } }))
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', cwd: '/wt/a' })
  expect(calls[0]?.command).toContain(`'uv' 'run' 'pytest'`)
  expect(calls[0]?.command).toMatch(/^\(echo [^&]+ && \{ \(cd '\/wt\/a' && /)
})

test('the same suite may run at once in different folders, not twice in one', async ($, on) => {
  const calls: Bash[] = []
  world(on, calls, 'bg10')
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  const elsewhere = await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true, cwd: '/wt/a' })
  const again = await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true, cwd: '/wt/a' })
  expect(calls).toHaveLength(2)
  expect(elsewhere.result).toMatch(/started as background task/)
  expect(again.result).toMatch(/already running/)
})

test('the footer keeps what the hooks beneath drew, with the runs after it', async ($, on) => {
  world(on, [], 'bg12')
  await startSession($)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  const ui = await $.ui.mount({ plugin: 'live-tests', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus', '+main 1.0M 0%'] } })
  const texts = linesOf(await ui.find({}))
  await ui.unmount()
  expect(texts).toHaveLength(3)
  expect(texts.slice(0, 2)).toEqual(['focus', 'main 1.0M 0%'])
  expect(texts[2]).toMatch(/^▶ unit \(bg\) /)
})

test('a column beneath keyed trailing: stays last, after the runs (live-tests outer)', async ($, on) => {
  world(on, [], 'bg13')
  await startSession($)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  const ui = await $.ui.mount({ plugin: 'live-tests', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus', '>main 1.0M 0%', '>claude 500M 2%'] } })
  const lines = linesOf(await ui.find({}))
  const column = await ui.find({ key: 'trailing:agent-usage' })
  await ui.unmount()
  expect(lines[0]).toBe('focus')
  expect(lines[1]).toMatch(/^▶ unit \(bg\) /)
  expect(lines.slice(2)).toEqual(['main 1.0M 0%', 'claude 500M 2%'])
  expect(column?.type).toBe('Box')
})

test('footer colours: a failed run has its ✗ and failure count in the theme error colour, its passed count in success, the rest dim', async ($, on) => {
  world(on, [])
  await startSession($)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit' })
  const ui = await $.ui.mount({ plugin: 'live-tests', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  expect(texts.filter(t => t.props.color === 'error').map(t => t.text)).toEqual(['✗', '1 ✗'])
  expect(texts.filter(t => t.props.color === 'success').map(t => t.text)).toEqual(['2 ✓'])
  const dim = texts.filter(t => t.props.dimColor === true).map(t => t.text)
  expect(dim).toHaveLength(3)
  expect(dim.slice(0, 2)).toEqual([' unit ', '  '])
  expect(dim[2]).toMatch(/^ \d+s$/)
})

test('the footer has a line for each run', async ($, on) => {
  world(on, [], 'bg11')
  await startSession($)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true, cwd: '/wt/a' })
  const rows = await footerRows($)
  expect(rows).toHaveLength(3)
  expect(rows[0]).toBe('focus')
  expect(rows[1]).toMatch(/^▶ unit \(bg\) /)
  expect(rows[2]).toMatch(/^▶ unit \(bg\) /)
})

test('a finished run stays in the footer when a run starts in another folder', async ($, on) => {
  world(on, [])
  await startSession($)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit' })
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', cwd: '/wt/a' })
  const rows = await footerRows($)
  expect(rows).toHaveLength(3)
  expect(rows[1]).toMatch(/^✗ unit /)
  expect(rows[2]).toMatch(/^✗ unit /)
})

test('rerunning a suite in the same folder replaces its finished line', async ($, on) => {
  world(on, [])
  await startSession($)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit' })
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit' })
  expect(await footerRows($)).toHaveLength(2)
})

test('with no config and nothing detected, run_tests says what to write', async ($, on) => {
  const { files } = world(on, [])
  files.delete('/proj/.claude/tests.json')
  const called = await $.tool.call({ tool: 'mcp__live-tests__run_tests' })
  expect(called.result).toMatch(/^No test suites are configured or detected in \/proj [\s\S]*write \/proj\/\.claude\/tests\.json[\s\S]*live-tests:setup-tests/)
})

test('an invalid local config is blamed by file, suite and field', async ($, on) => {
  const calls: Bash[] = []
  const { files } = world(on, calls)
  files.set('/proj/.claude/tests.local.json', JSON.stringify({ suites: { e2e: { argv: 'pytest e2e' } } }))
  const called = await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit' })
  expect(calls).toHaveLength(0)
  expect(called.result).toMatch(/^tests config error in \/proj\/\.claude\/tests\.local\.json: suite "e2e": "argv" must be a non-empty list of strings/)
})

test('the tool description carries a config error instead of claiming there are no suites', async ($, on) => {
  const { files, descriptions } = world(on, [])
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  files.set('/proj/.claude/tests.json', '{ not json')
  await startSession($)
  expect(descriptions.at(-1)).toMatch(/The tests config has an error, so no suites are listed: tests config error in \/proj\/\.claude\/tests\.json: not valid JSON/)
})

// The kit does not pass a mod's own $.session.append through the test's hooks, so the notice's row
// is not seen here. What is: the run's summary counts the failures its notices sent, and building
// the notice runs register.tsx's notify end to end; a throw there (an import gone missing) fails
// this file as "a rejection nothing handled".
test('a background run with failureNotices each sends its failure mid-run; the summary says it was reported', async ($, on) => {
  const { rows, clock, files } = world(on, [], 'bg20')
  // Answered here so session.start runs whole and starts the poller that sends notices.
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  await startSession($)
  const started = await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true, failureNotices: 'each' })
  expect(started.result).toMatch(/started as background task bg20/)
  await clock.advance(600)
  complete(files)
  await clock.advance(600)
  await append($, notification('bg20'))
  expect(textOf(rows[0] ?? [])).toMatch(/✗ unit: 2 passed, 1 failed \(exit 1\)\n1 failure was already reported during the run\.\n/)
})

test('with failureNotices off nothing is sent mid-run, so the summary reports none', async ($, on) => {
  const { rows, clock, files } = world(on, [], 'bg21')
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  await startSession($)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true, failureNotices: 'off' })
  await clock.advance(600)
  complete(files)
  await clock.advance(600)
  await append($, notification('bg21'))
  expect(textOf(rows[0] ?? [])).toMatch(SUMMARY)
  expect(textOf(rows[0] ?? [])).not.toMatch(/already reported/)
})

// A subagent's run: its Bash task is main's, so Claude Code's notification lands in main. Main must get
// nothing of it: the mod answers that notification's prompt.submit without next, so it never enters, and
// adds nothing to its row. The summary itself goes to the subagent through the mod's own
// $.session.append, which this kit does not route through a test's hooks (deliveryFor is tested alone).
const submitted = (on: On) => {
  const texts: string[] = []
  on('prompt.submit', (_$, e) => {
    texts.push(e.text)
    return { text: e.text }
  })
  return texts
}

const notify = ($: Engine, taskId: string) =>
  $.prompt.submit({ text: notification(taskId), wait: false, origin: { kind: 'task-notification' } }).catch(() => undefined)

const AGENT_STATES = [
  ['still running', 'running'],
  ['already ended', 'completed'],
] as const

for (const [state, status] of AGENT_STATES) {
  test(`a subagent's background run whose agent is ${state}: main's notification never enters, its row gets nothing`, async ($, on) => {
    const { files, rows } = world(on, [], 'bg30')
    const texts = submitted(on)
    on('agent.list', () => ({ value: [{ ...FIXER[0], status }] }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    await startSession($)
    await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true, agentId: 'f2' })
    complete(files)
    const answered = await notify($, 'bg30')
    await append($, notification('bg30'))
    await deliver($, notification('bg30'))
    expect(texts).toEqual([])
    expect(answered).toEqual({ text: notification('bg30'), origin: { kind: 'task-notification' } })
    expect(rows.map(textOf)).toEqual([notification('bg30'), notification('bg30')])
    // The run is settled all the same: its result stays in the footer.
    expect(await footerModes($)).toMatch(/✗ unit/)
  })

  test(`a subagent's run whose agent is ${state} drives its failure notices and leaves main's row bare (no pointer)`, async ($, on) => {
    const { files, rows, clock } = world(on, [], 'bg31')
    submitted(on)
    on('agent.list', () => ({ value: [{ ...FIXER[0], status }] }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    await startSession($)
    await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true, agentId: 'f2', failureNotices: 'each' })
    await clock.advance(600)
    complete(files)
    await clock.advance(600)
    await append($, notification('bg31'))
    expect(rows.map(textOf)).toEqual([notification('bg31')])
  })
}

test("a main run's notification still enters and carries the summary", async ($, on) => {
  const { files, rows } = world(on, [], 'bg32')
  const texts = submitted(on)
  await startSession($)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true })
  complete(files)
  await notify($, 'bg32')
  await append($, notification('bg32'))
  expect(texts).toEqual([notification('bg32')])
  expect(textOf(rows[0] ?? [])).toMatch(SUMMARY)
})

test('a notification of a task the mod did not start still enters', async ($, on) => {
  world(on, [], 'bg33')
  const texts = submitted(on)
  on('agent.list', () => ({ value: FIXER }))
  await startSession($)
  await $.tool.call({ tool: 'mcp__live-tests__run_tests', suite: 'unit', background: true, agentId: 'f2' })
  await notify($, 'other')
  expect(texts).toEqual([notification('other')])
})
