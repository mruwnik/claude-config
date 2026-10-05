import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { snapshotPath } from './diff'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
type Mounted = Awaited<ReturnType<Engine['ui']['mount']>>

const HOME = '/home/u'
const snap = (abs: string): string => snapshotPath(HOME, abs)

const mdCommand = (args: string) => ({
  command: 'md',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: true, columns: 120 },
})

type Files = Map<string, { text: string; mtimeMs: number }>

/** A file system with writes: a `fs.write` lands in `files` (and counts in `writes`), a read of a missing file is an error. */
const world = (on: On, files: Files, isWriteRefused: boolean) => {
  const writes: Array<{ path: string; text: string }> = []
  const abs = (path: string): string => (path.startsWith('/') ? path : `/work/${path}`)
  on('fs.stat', (_, e) => {
    const file = files.get(abs(e.path))
    if (file === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const file = files.get(abs(e.path))
    if (file === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: file.text }
  })
  on('fs.write', (_, e) => {
    if (isWriteRefused) return { deny: 'EACCES' }
    writes.push({ path: e.path, text: e.text })
    files.set(e.path, { text: e.text, mtimeMs: 1 })
    return { value: undefined }
  })
  return writes
}

const started = async ($: Engine, on: On, files: Files, isWriteRefused = false) => {
  const writes = world(on, files, isWriteRefused)
  mock.env(on, { HOME })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__md-view__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  return { writes, clock }
}

const BODY_ROWS = 20

const pane = (surface: Surface) =>
  ({
    plugin: 'md-view',
    surface,
    component: 'Pane',
    requestId: 'md-view',
    props: { title: 'x', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: BODY_ROWS }, view: {} },
  }) as never

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
/** The gutter markers drawn, by color, in row order. */
const gutters = async (ui: Mounted) =>
  (await ui.findAll({ type: 'Text', text: '▌' })).filter(t => t.text === '▌').map(t => t.props.color)
const header = async (ui: Mounted) => flat(keyed(await ui.drawn(), 'head')?.children?.[0]).match(/\d+ changes? since you last looked ·$/)?.[0]

const OLD = '# Doc\n\nkept paragraph\n\nsecond paragraph about cats\n\nthird paragraph\n\ndoomed paragraph that goes away\n'
const NEW = '# Doc\n\nkept paragraph\n\nsecond paragraph about cats and dogs\n\nthird paragraph\n\nbrand new addition\n'
const A = '/work/a.md'

test('a first open has no snapshot: nothing is marked yet and no error shows', async ($, on) => {
  const files: Files = new Map([[A, { text: NEW, mtimeMs: 1 }]])
  const { writes } = await started($, on, files)
  const out = await $.command.run(mdCommand(A))
  expect(out.text).toBe('Showing /work/a.md.')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await header(ui)).toBeUndefined()
    expect(await gutters(ui)).toEqual([])
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    expect((await rowTexts(ui)).every(r => r === '' || r.startsWith('  '))).toBe(true)
    await ui.unmount()
  }
  expect(writes).toEqual([])
})

test('a first open marks edits that arrive while it is open against the text it opened with', async ($, on) => {
  const files: Files = new Map([[A, { text: OLD, mtimeMs: 1 }]])
  const { writes, clock } = await started($, on, files)
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  expect(await header(ui)).toBeUndefined()

  files.set(A, { text: NEW, mtimeMs: 2 })
  await clock.advance(1000)
  expect(await header(ui)).toBe('2 changes since you last looked ·')
  expect(await gutters(ui)).toEqual(['warning', 'error', 'success'])
  // the baseline is kept in memory: nothing is written until the person stops viewing
  expect(writes).toEqual([])
  await ui.unmount()
})

for (const surface of SURFACES) {
  test(`on ${surface}, reopening after the file changed counts the changes and marks their rows`, async ($, on) => {
    const files: Files = new Map([[A, { text: NEW, mtimeMs: 1 }], [snap(A), { text: OLD, mtimeMs: 1 }]])
    await started($, on, files)
    await $.command.run(mdCommand(A))
    const ui = await $.ui.mount(pane(surface))

    expect(await header(ui)).toBe('2 changes since you last looked ·')
    const button = await ui.find({ type: 'Button', key: 'next-change' })
    expect(button?.props.hotkey).toBe('n')

    expect((await rowTexts(ui)).slice(0, 13)).toEqual([
      '  Doc',
      '  ═══',
      '',
      '  kept paragraph',
      '',
      '▌ second paragraph about cats and dogs',
      '',
      '  third paragraph',
      '',
      '▌ doomed paragraph that goes away',
      '',
      '▌ brand new addition',
      '',
    ])
    expect(await gutters(ui)).toEqual(['warning', 'error', 'success'])
    const texts = await ui.findAll({ type: 'Text' })
    const struck = texts.filter(t => t.props.strikethrough === true)
    expect(struck.map(t => t.text)).toEqual(['doomed paragraph that goes away'])
    // GitHub's rich diff: whole removed and added rows on the line backgrounds, changed words on the word ones
    const backed = (color: string) => texts.filter(t => t.props.backgroundColor === color).map(t => t.text.trim())
    expect(backed('diffRemoved')).toEqual(['▌ doomed paragraph that goes away'])
    expect(backed('diffAdded')).toEqual(['▌ brand new addition'])
    expect(backed('diffAddedWord')).toEqual(['and dogs'])
    await ui.unmount()
  })
}

test('opening another doc saves the first one, and the second one is marked against its own snapshot', async ($, on) => {
  const B = '/work/b.md'
  const files: Files = new Map([
    [A, { text: NEW, mtimeMs: 1 }],
    [B, { text: 'b now\n\nmore\n', mtimeMs: 1 }],
    [snap(B), { text: 'b then\n\nmore\n', mtimeMs: 1 }],
  ])
  const { writes } = await started($, on, files)
  await $.command.run(mdCommand(A))
  expect(writes).toEqual([])
  await $.command.run(mdCommand(B))
  expect(writes).toEqual([{ path: snap(A), text: NEW }])

  const ui = await $.ui.mount(pane('terminal'))
  expect(await header(ui)).toBe('1 change since you last looked ·')
  await ui.unmount()

  // the same doc again is not a switch
  await $.command.run(mdCommand('b.md'))
  expect(writes).toHaveLength(1)
  const again = await $.ui.mount(pane('terminal'))
  expect(await header(again)).toBe('1 change since you last looked ·')
  await again.unmount()
})

const grid = (rows: string[]): string => `| key | value |\n|---|---|\n${rows.map(r => `| ${r} |\n`).join('')}`

for (const surface of SURFACES) {
  test(`on ${surface}, a changed table row gets the gutter mark and no other row does`, async ($, on) => {
    const before = `# T\n\n${grid(['alpha | 1', 'beta | 2', 'gamma | 3'])}\nafter\n`
    const after = `# T\n\n${grid(['alpha | 1', 'beta | 22', 'gamma | 3'])}\nafter\n`
    const files: Files = new Map([[A, { text: after, mtimeMs: 1 }], [snap(A), { text: before, mtimeMs: 1 }]])
    await started($, on, files)
    await $.command.run(mdCommand(A))
    const ui = await $.ui.mount(pane(surface))
    expect(await header(ui)).toBe('1 change since you last looked ·')
    expect((await rowTexts(ui)).filter(r => r.startsWith('▌'))).toEqual(['▌ │ beta  │ 22    │'])
    expect(await gutters(ui)).toEqual(['warning'])
    await ui.unmount()
  })
}

test('a removed table row is listed struck through under the table', async ($, on) => {
  const files: Files = new Map([[A, { text: grid(['alpha | 1']), mtimeMs: 1 }], [snap(A), { text: grid(['alpha | 1', 'beta | 2']), mtimeMs: 1 }]])
  await started($, on, files)
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  const struck = (await ui.findAll({ type: 'Text' })).filter(t => t.props.strikethrough === true)
  expect(struck.map(t => t.text)).toEqual(['beta │ 2'])
  expect((await rowTexts(ui)).slice(4, 6)).toEqual(['  └───────┴───────┘', '▌ beta │ 2'])
  await ui.unmount()
})

const para = (i: number, extra = ''): string => `para${i} ${'word '.repeat(60)}${extra}\n\n`
const paras = (count: number, edited: number[]): string =>
  Array.from({ length: count }, (_, i) => para(i, edited.includes(i) ? ` edit${i}` : '')).join('')

for (const surface of SURFACES) {
  test(`on ${surface}, n jumps to each change in turn, far down the doc, and wraps round`, async ($, on) => {
    const files: Files = new Map([[A, { text: paras(40, [0, 25, 39]), mtimeMs: 1 }], [snap(A), { text: paras(40, []), mtimeMs: 1 }]])
    await started($, on, files)
    await $.command.run(mdCommand(A))
    const ui = await $.ui.mount(pane(surface))
    expect(await header(ui)).toBe('3 changes since you last looked ·')
    const top = async () => (await docRows(ui))[0]
    expect(await top()).toMatch(/^para0 /)
    await ui.press({ key: 'next-change' })
    expect(await top()).toMatch(/^para0 /)
    expect((await rowTexts(ui))[0]?.startsWith('▌')).toBe(true)
    await ui.press({ key: 'next-change' })
    expect(await top()).toMatch(/^para25 /)
    expect((await rowTexts(ui))[0]?.startsWith('▌')).toBe(true)
    await ui.press({ key: 'next-change' })
    expect((await docRows(ui)).some(r => r.startsWith('para39 '))).toBe(true)
    await ui.press({ key: 'next-change' })
    expect(await top()).toMatch(/^para0 /)
    await ui.unmount()
  })
}

test('n lands a change inside a long table just under its pinned header', async ($, on) => {
  const rows = (k: number) => Array.from({ length: 60 }, (_, i) => `r${i} | ${i === 30 ? k : 0}`)
  const files: Files = new Map([[A, { text: `# T\n\n${grid(rows(1))}`, mtimeMs: 1 }], [snap(A), { text: `# T\n\n${grid(rows(0))}`, mtimeMs: 1 }]])
  await started($, on, files)
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'next-change' })
  const shown = await rowTexts(ui)
  expect(shown.slice(0, 2).map(r => r.slice(2))).toEqual(['┌─────┬───────┐', '│ key │ value │'])
  expect(shown[3]).toBe('▌ │ r30 │ 1     │')
  await ui.unmount()
})

test('edits that arrive while the pane is open are marked against the same baseline', async ($, on) => {
  const files: Files = new Map([[A, { text: OLD, mtimeMs: 1 }], [snap(A), { text: OLD, mtimeMs: 1 }]])
  const { writes, clock } = await started($, on, files)
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  expect(await header(ui)).toBeUndefined()

  files.set(A, { text: NEW, mtimeMs: 2 })
  await clock.advance(1000)
  expect(await header(ui)).toBe('2 changes since you last looked ·')

  files.set(A, { text: `${NEW}\nand a last line\n`, mtimeMs: 3 })
  await clock.advance(1000)
  expect(await header(ui)).toBe('2 changes since you last looked ·')
  expect(await docRows(ui)).toContain('and a last line')
  expect(writes).toEqual([])

  // back to the baseline's text: nothing is marked any more
  files.set(A, { text: OLD, mtimeMs: 4 })
  await clock.advance(1000)
  expect(await header(ui)).toBeUndefined()
  expect(await gutters(ui)).toEqual([])
  await ui.unmount()
})

test('a snapshot that cannot be written is ignored quietly when another doc is opened', async ($, on) => {
  const files: Files = new Map([[A, { text: NEW, mtimeMs: 1 }], ['/work/b.md', { text: 'b', mtimeMs: 1 }]])
  const { writes } = await started($, on, files, true)
  await $.command.run(mdCommand(A))
  const out = await $.command.run(mdCommand('/work/b.md'))
  expect(out.text).toBe('Showing /work/b.md.')
  expect(writes).toEqual([])
  const ui = await $.ui.mount(pane('terminal'))
  expect((await docRows(ui))[0]).toBe('b')
  await ui.unmount()
})

test('the session ending with the pane open saves what was shown as its snapshot', async ($, on) => {
  const files: Files = new Map([[A, { text: NEW, mtimeMs: 1 }]])
  const { writes } = await started($, on, files)
  await $.command.run(mdCommand(A))
  expect(writes).toEqual([])

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } } as never)
  expect(writes).toEqual([{ path: snap(A), text: NEW }])
})

test('the session ending with no pane open saves nothing', async ($, on) => {
  const { writes } = await started($, on, new Map())
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } } as never)
  expect(writes).toEqual([])
})

const headLine = async (ui: Mounted) => flat(keyed(await ui.drawn(), 'head')?.children?.[0])
const TWO_BEFORE = 'one\n\ntwo\n\nthree\n'
const TWO_AFTER = 'ONE\n\ntwo\n\nTHREE\n'

for (const surface of SURFACES) {
  test(`on ${surface}, accept and reject show only once n has picked a change, and the header names it`, async ($, on) => {
    const files: Files = new Map([[A, { text: TWO_AFTER, mtimeMs: 1 }], [snap(A), { text: TWO_BEFORE, mtimeMs: 1 }]])
    await started($, on, files)
    await $.command.run(mdCommand(A))
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Button', key: 'accept-change' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'reject-change' })).toBeUndefined()

    await ui.press({ key: 'next-change' })
    expect(await headLine(ui)).toMatch(/ · change 1 of 2 ·$/)
    expect((await ui.find({ type: 'Button', key: 'accept-change' }))?.props.hotkey).toBe('a')
    expect((await ui.find({ type: 'Button', key: 'reject-change' }))?.props.hotkey).toBe('r')
    await ui.unmount()
  })
}

test('accept stops marking the picked change, leaves the file alone, and picks the change now in its place', async ($, on) => {
  const files: Files = new Map([[A, { text: TWO_AFTER, mtimeMs: 1 }], [snap(A), { text: TWO_BEFORE, mtimeMs: 1 }]])
  const { writes } = await started($, on, files)
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'next-change' })
  await ui.press({ key: 'accept-change' })

  expect(await headLine(ui)).toMatch(/ · change 1 of 1 ·$/)
  expect(await gutters(ui)).toEqual(['warning'])
  expect((await rowTexts(ui)).filter(r => r.startsWith('▌'))).toEqual(['▌ threeTHREE'])
  expect(writes).toEqual([])

  await ui.press({ key: 'accept-change' })
  expect(await header(ui)).toBeUndefined()
  expect(await gutters(ui)).toEqual([])
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(writes).toEqual([])
  await ui.unmount()
})

test('reject writes the picked change back as the baseline has it, and only that change', async ($, on) => {
  const files: Files = new Map([[A, { text: TWO_AFTER, mtimeMs: 1 }], [snap(A), { text: TWO_BEFORE, mtimeMs: 1 }]])
  const { writes, clock } = await started($, on, files)
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'next-change' })
  await ui.press({ key: 'reject-change' })

  expect(writes).toEqual([{ path: A, text: 'one\n\ntwo\n\nTHREE\n' }])
  expect(await headLine(ui)).toMatch(/ · change 1 of 1 ·$/)
  expect(await docRows(ui)).toContain('one')
  expect((await rowTexts(ui)).filter(r => r.startsWith('▌'))).toEqual(['▌ threeTHREE'])

  // the poll reads back what was written: nothing changes
  await clock.advance(1000)
  expect(await headLine(ui)).toMatch(/ · change 1 of 1 ·$/)
  await ui.unmount()
})

test('a reject that cannot be written leaves the doc as it was and says why', async ($, on) => {
  const files: Files = new Map([[A, { text: TWO_AFTER, mtimeMs: 1 }], [snap(A), { text: TWO_BEFORE, mtimeMs: 1 }]])
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await started($, on, files, true)
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'next-change' })
  await ui.press({ key: 'reject-change' })
  expect(toasts).toEqual([expect.stringMatching(/^Cannot reject the change: .*EACCES/)])
  expect(await headLine(ui)).toMatch(/ · change 1 of 2 ·$/)
  expect(files.get(A)?.text).toBe(TWO_AFTER)
  await ui.unmount()
})
