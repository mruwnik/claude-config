import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { stats } from './view'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
type Mounted = Awaited<ReturnType<Engine['ui']['mount']>>
const TOOL = 'mcp__md-view__ShowDoc'
const BODY_ROWS = 20
// the header takes one row: the doc's window is the rest
const WINDOW = BODY_ROWS - 1

const mdCommand = (args: string) => ({
  command: 'md',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: true, columns: 120 },
})

type Files = Map<string, { text: string; mtimeMs: number }>

const fakeFs = (on: On, files: Files) => {
  on('fs.stat', (_, e) => {
    const file = files.get(e.path)
    if (file === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const file = files.get(e.path)
    if (file === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: file.text }
  })
}

const pane = (surface: Surface, bodyColumns = 80) =>
  ({
    plugin: 'md-view',
    surface,
    component: 'Pane',
    requestId: 'md-view',
    props: { title: 'x', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: BODY_ROWS }, view: {} },
  }) as never

const started = async ($: Engine, on: On, files: Files) => {
  fakeFs(on, files)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__md-view__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  return clock
}

/** The engine's own end of ui.scroll: records what reached it (md-view keeps every move, so nothing should). */
const recordScrolls = (on: On) => {
  const reached: number[] = []
  on('ui.scroll', (_, e) => {
    reached.push(e.offset)
    return {}
  })
  return reached
}

const scroll = (by: number) =>
  ({ component: 'Pane', requestId: 'md-view', offset: 0, by, bodyRows: BODY_ROWS, contentRows: BODY_ROWS + 1, origin: { kind: 'person' } }) as never

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
const flat = (n: unknown): string =>
  typeof n === 'string' || typeof n === 'number' ? String(n) : ((n as Node)?.children ?? []).map(flat).join('')
const keyed = (n: unknown, key: string): Node | undefined => {
  const node = n as Node
  if (node?.props?.key === key) return node
  for (const c of node?.children ?? []) {
    const hit = typeof c === 'object' && c !== null ? keyed(c, key) : undefined
    if (hit !== undefined) return hit
  }
  return undefined
}
/** The doc rows the pane shows, gutter included, trailing spaces off. */
const rowTexts = async (ui: Mounted) => (keyed(await ui.drawn(), 'rows')?.children ?? []).map(c => flat(c).trimEnd())


const docRows = async (ui: Mounted) => (await rowTexts(ui)).map(t => t.slice(2))
const header = async (ui: Mounted) => flat(keyed(await ui.drawn(), 'head')?.children?.[0])

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n\n')

test('/md opens the pane and draws the doc as rows on every surface', async ($, on) => {
  await started($, on, new Map([['/work/a.md', { text: '# Title\n\nhello **there**', mtimeMs: 1 }]]))
  const out = await $.command.run(mdCommand('/work/a.md'))
  expect(out.text).toBe('Showing /work/a.md.')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect((await docRows(ui)).slice(0, 4)).toEqual(['Title', '═════', '', 'hello there'])
    expect(await header(ui)).toMatch(/^\/work\/a\.md · updated \d\d:\d\d:\d\d · all$/)
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    const bold = (await ui.findAll({ type: 'Text' })).find(t => t.text === 'there')
    expect(bold?.props.bold).toBe(true)
    await ui.unmount()
  }
})

for (const surface of SURFACES) {
  test(`on ${surface} the tree is the header, a full window of rows and one spare row`, async ($, on) => {
    await started($, on, new Map([['/work/n.md', { text: numbered(100), mtimeMs: 1 }]]))
    await $.command.run(mdCommand('/work/n.md'))
    const ui = await $.ui.mount(pane(surface))
    const rows = await docRows(ui)
    expect(rows).toHaveLength(WINDOW)
    expect(rows.slice(0, 3)).toEqual(['line 0', '', 'line 1'])
    const tree = (await ui.drawn()) as Node
    expect(tree.children).toHaveLength(3) // header, the window, the spare row
    expect(keyed(tree, 'rows')?.children).toHaveLength(WINDOW)
    expect(flat(tree.children?.[2])).toBe(' ')
    expect(await header(ui)).toMatch(/ · 0%$/)
    await ui.unmount()
  })
}

test('a short doc fills the window with blank rows and says it shows all', async ($, on) => {
  await started($, on, new Map([['/work/s.md', { text: 'short', mtimeMs: 1 }]]))
  await $.command.run(mdCommand('/work/s.md'))
  const ui = await $.ui.mount(pane('terminal'))
  expect(await docRows(ui)).toEqual(['short', ...Array.from({ length: WINDOW - 1 }, () => '')])
  expect(await header(ui)).toMatch(/ · all$/)
  expect(await ui.find({ type: 'Button', key: 'next-change' })).toBeUndefined()
  await ui.unmount()
})

for (const surface of SURFACES) {
  test(`on ${surface} the person's scrolls move md-view's own window and never the engine's`, async ($, on) => {
    const reached = recordScrolls(on)
    await started($, on, new Map([['/work/n.md', { text: numbered(100), mtimeMs: 1 }]]))
    await $.command.run(mdCommand('/work/n.md'))
    const ui = await $.ui.mount(pane(surface))
    const first = async () => (await docRows(ui))[0]

    await $.ui.scroll(scroll(2))
    expect(await first()).toBe('line 1')
    await $.ui.scroll(scroll(-1))
    expect(await first()).toBe('')
    await $.ui.scroll(scroll(BODY_ROWS)) // page down: a window, from row 1 to row 20
    expect(await first()).toBe('line 10')
    await $.ui.scroll(scroll(BODY_ROWS + 1)) // End
    expect((await docRows(ui))[WINDOW - 1]).toBe('line 99')
    expect(await header(ui)).toMatch(/ · 100%$/)
    await $.ui.scroll(scroll(5)) // past the end stays
    expect((await docRows(ui))[WINDOW - 1]).toBe('line 99')
    await $.ui.scroll(scroll(-(BODY_ROWS + 1))) // Home
    expect(await first()).toBe('line 0')
    await $.ui.scroll(scroll(-3)) // past the top stays
    expect(await first()).toBe('line 0')
    expect(reached).toEqual([])
    await ui.unmount()
  })
}

test('a scroll step reuses the layout: no whole-doc work per step', async ($, on) => {
  await started($, on, new Map([['/work/n.md', { text: numbered(300), mtimeMs: 1 }]]))
  await $.command.run(mdCommand('/work/n.md'))
  const ui = await $.ui.mount(pane('terminal'))
  const before = stats.layouts
  for (let i = 0; i < 10; i++) await $.ui.scroll(scroll(3))
  expect((await docRows(ui))[0]).toBe('line 15')
  expect(stats.layouts).toBe(before)
  await ui.unmount()
})

test('a huge doc draws only its window: far under the 100k tree limit', async ($, on) => {
  const huge = Array.from({ length: 3000 }, (_, i) => `para ${i} ${'word '.repeat(60)}`).join('\n\n')
  expect(huge.length).toBeGreaterThan(500000)
  await started($, on, new Map([['/work/h.md', { text: huge, mtimeMs: 1 }]]))
  await $.command.run(mdCommand('/work/h.md'))
  const ui = await $.ui.mount(pane('terminal'))
  const drawn = (await ui.findAll({ type: 'Text' })).reduce((n, t) => n + t.text.length, 0)
  expect(drawn).toBeLessThan(5000)
  await $.ui.scroll(scroll(BODY_ROWS + 1))
  expect((await docRows(ui)).filter(r => r !== '').pop()).toMatch(/word$/)
  await ui.unmount()
})

const tallTable = `# T\n\nbefore\n\n| a | b |\n|---|---|\n${Array.from({ length: 40 }, (_, i) => `| r${i} | v${i} |`).join('\n')}\n\nafter\n${numbered(30)}`

for (const surface of SURFACES) {
  test(`on ${surface} a table's header is pinned while its body scrolls under it, and not elsewhere`, async ($, on) => {
    await started($, on, new Map([['/work/t.md', { text: tallTable, mtimeMs: 1 }]]))
    await $.command.run(mdCommand('/work/t.md'))
    const ui = await $.ui.mount(pane(surface))
    // rows: T, ═, blank, before, blank, then the table from row 5: border, header, separator, r0 at row 8
    expect((await docRows(ui)).slice(5, 9)).toEqual(['┌─────┬─────┐', '│ a   │ b   │', '├─────┼─────┤', '│ r0  │ v0  │'])

    await $.ui.scroll(scroll(10))
    await $.ui.scroll(scroll(10)) // window top at row 20: r12 is under the pinned header, r15 shows first
    const rows = await docRows(ui)
    expect(rows.slice(0, 4)).toEqual(['┌─────┬─────┐', '│ a   │ b   │', '├─────┼─────┤', '│ r15 │ v15 │'])
    const pinned = (await ui.findAll({ type: 'Text' })).filter(t => t.props.backgroundColor === 'userMessageBackground')
    expect(pinned).toHaveLength(3)

    await $.ui.scroll(scroll(40)) // window top at row 60: past the table
    expect((await docRows(ui)).some(r => r.startsWith('│ a '))).toBe(false)
    expect((await ui.findAll({ type: 'Text' })).filter(t => t.props.backgroundColor === 'userMessageBackground')).toEqual([])
    await ui.unmount()
  })
}

test('/md on a missing file replies with the error and shows the empty state', async ($, on) => {
  await started($, on, new Map())
  const out = await $.command.run(mdCommand('nope.md'))
  expect(out.text).toMatch(/^Cannot show nope\.md: /)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /No doc open/ })).toBeDefined()
    await ui.unmount()
  }
})

test('with no doc open a scroll passes to the engine', async ($, on) => {
  const reached = recordScrolls(on)
  await started($, on, new Map())
  const ui = await $.ui.mount(pane('terminal'))
  await $.ui.scroll(scroll(1))
  expect(reached).toEqual([0])
  await ui.unmount()
})

test('ShowDoc opens the file and answers briefly; a missing file is an error', async ($, on) => {
  await started($, on, new Map([['/work/b.md', { text: 'body', mtimeMs: 1 }]]))
  const ok = await $.tool.call({ tool: TOOL, path: '/work/b.md' })
  expect(ok.result).toBe('Showing /work/b.md in the side pane.')
  const ui = await $.ui.mount(pane('terminal'))
  expect((await docRows(ui))[0]).toBe('body')
  await ui.unmount()
  const bad = await $.tool.call({ tool: TOOL, path: '/work/none.md' })
  expect(bad.isError).toBe(true)
})

test('a change on disk is picked up after the clock advances; deletion shows a notice', async ($, on) => {
  const files: Files = new Map([['/work/c.md', { text: 'one', mtimeMs: 1 }]])
  const clock = await started($, on, files)
  await $.command.run(mdCommand('/work/c.md'))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    files.set('/work/c.md', { text: 'one', mtimeMs: 1 })
    await clock.advance(1000)
    expect(await docRows(ui)).toContain('one')

    files.set('/work/c.md', { text: 'two', mtimeMs: 2 })
    await clock.advance(1000)
    expect(await docRows(ui)).toContain('two')

    files.delete('/work/c.md')
    await clock.advance(1000)
    expect(await ui.find({ type: 'Text', text: /File not found/ })).toBeDefined()
    expect(await docRows(ui)).toHaveLength(WINDOW - 1)
    expect(await docRows(ui)).toContain('two')

    files.set('/work/c.md', { text: 'three', mtimeMs: 3 })
    await clock.advance(1000)
    expect(await docRows(ui)).toContain('three')
    expect(await ui.find({ type: 'Text', text: /File not found/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a doc that shrinks on a live update keeps the window inside it', async ($, on) => {
  // opened tiny, so going back to tiny leaves no removed rows listed: the doc really shrinks
  const files: Files = new Map([['/work/n.md', { text: 'tiny', mtimeMs: 1 }]])
  const clock = await started($, on, files)
  await $.command.run(mdCommand('/work/n.md'))
  const ui = await $.ui.mount(pane('terminal'))
  files.set('/work/n.md', { text: numbered(100), mtimeMs: 2 })
  await clock.advance(1000)
  await $.ui.scroll(scroll(BODY_ROWS + 1))
  files.set('/work/n.md', { text: 'tiny', mtimeMs: 3 })
  await clock.advance(1000)
  expect((await docRows(ui))[0]).toBe('tiny')
  await $.ui.scroll(scroll(-1))
  expect((await docRows(ui))[0]).toBe('tiny')
  await ui.unmount()
})

test('opening another file starts at its top; reopening the same one keeps the place', async ($, on) => {
  await started(
    $,
    on,
    new Map([
      ['/work/n.md', { text: numbered(100), mtimeMs: 1 }],
      ['/work/o.md', { text: numbered(100).replaceAll('line', 'other'), mtimeMs: 1 }],
    ]),
  )
  await $.command.run(mdCommand('/work/n.md'))
  const ui = await $.ui.mount(pane('terminal'))
  await $.ui.scroll(scroll(10))
  await $.command.run(mdCommand('/work/n.md'))
  expect((await docRows(ui))[0]).toBe('line 5')
  await $.command.run(mdCommand('/work/o.md'))
  expect((await docRows(ui))[0]).toBe('other 0')
  await ui.unmount()
})

test('after a hot reload the restored doc and place are drawn and polled again on session start', async ($, on) => {
  const files: Files = new Map([['/work/d.md', { text: numbered(50), mtimeMs: 2 }]])
  fakeFs(on, files)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__md-view__${e.name}` } }))
  const clock = mock.clock(on, { now: 1_000_000 })
  // $.state survives a hot reload: hold it in a store seeded before session start
  const held = new Map<string, { value: unknown; version: number }>([
    ['doc', { value: { path: '/work/d.md', title: 'd.md', text: 'old', mtimeMs: 1, updatedAt: 1_000_000, isMissing: false }, version: 1 }],
    ['view', { value: { offset: 4, hunk: -1 }, version: 1 }],
  ])
  on('state.get', (_, e) => ({ value: held.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const version = (held.get(e.key)?.version ?? 0) + 1
    held.set(e.key, { value: e.value, version })
    return { value: { isSet: true, version } }
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  const ui = await $.ui.mount(pane('terminal'))
  expect((await docRows(ui))[0]).toBe('line 2')
  await ui.unmount()
})

test('a wide table is drawn within bodyColumns, the gutter included', async ($, on) => {
  const cell = 'long cell with `inline code` and a very-long-hyphenated-identifier-that-never-ends and more words '.repeat(3)
  const wide = `| Name | Description | Notes |\n|---|---|---|\n${Array.from({ length: 3 }, (_, i) => `| \`row${i}\` | ${cell} | ${cell} |`).join('\n')}\n`
  await started($, on, new Map([['/work/w.md', { text: wide, mtimeMs: 1 }]]))
  await $.command.run(mdCommand('/work/w.md'))
  for (const width of [80, 50, 30]) {
    const ui = await $.ui.mount(pane('terminal', width))
    const rows = await rowTexts(ui)
    expect(rows.some(r => r.includes('Name'))).toBe(true)
    expect(Math.max(...rows.map(r => Array.from(r).length))).toBeLessThanOrEqual(width)
    await ui.unmount()
  }
})
