import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted as MountedOn } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
type Mounted = MountedOn<Surface, 'Pane'>

const A = '/work/a.md'
const BODY_ROWS = 20

const mdCommand = (args: string) => ({
  command: 'md',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: true, columns: 120 },
})

type Files = Map<string, { text: string; mtimeMs: number }>

/** A file system whose writes land in `files` with a fresh mtime, and a record of every write and toast. */
const started = async ($: Engine, on: On, files: Files) => {
  const writes: Array<{ path: string; text: string }> = []
  const toasts: string[] = []
  let mtime = 100
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
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    mtime += 1
    files.set(e.path, { text: e.text, mtimeMs: mtime })
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__md-view__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  return { writes, toasts, clock }
}

const pane = <S extends Surface>(surface: S) => ({
  plugin: 'md-view',
  surface,
  component: 'Pane' as const,
  requestId: 'md-view',
  props: { title: 'x', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: BODY_ROWS }, view: {} } as never,
})

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

/** The source lines the editor shows, gutter off, trailing spaces off. */
const editorLines = async (ui: Mounted) =>
  (keyed(await ui.drawn({ in: 'editor' }), 'lines')?.children ?? []).map(c => flat(c).slice(2).trimEnd())
/** The editor's status line: its tree's last row (a Client's drawn tree keeps no Text keys). */
const editorStatus = async (ui: Mounted) => flat(((await ui.drawn({ in: 'editor' })) as Node).children?.at(-1))
const docRows = async (ui: Mounted) => (keyed(await ui.drawn(), 'rows')?.children ?? []).map(c => flat(c).slice(2).trimEnd())
const header = async (ui: Mounted) => flat(keyed(await ui.drawn(), 'head')?.children?.[0])

const typeText = async (ui: Mounted, text: string) => {
  for (const ch of text) await ui.key({ key: ch, in: 'editor' })
}
const save = (ui: Mounted) => ui.key({ key: 's', ctrl: true, in: 'editor' })

for (const surface of SURFACES) {
  test(`on ${surface} e shows the raw source in an editor and back to the rendered doc`, async ($, on) => {
    await started($, on, new Map([[A, { text: '# Title\n\nhello **there**', mtimeMs: 1 }]]))
    await $.command.run(mdCommand(A))
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ key: 'editor' })).toBeUndefined()

    await ui.press({ key: 'toggle-edit' })
    expect((await editorLines(ui)).slice(0, 3)).toEqual(['# Title', '', 'hello **there**'])
    expect(await header(ui)).toMatch(/ · editing$/)
    expect(await editorStatus(ui)).toMatch(/ln 1, col 1/)

    await ui.press({ key: 'toggle-edit' })
    expect(await ui.find({ key: 'editor' })).toBeUndefined()
    expect((await docRows(ui))[0]).toBe('Title')
    await ui.unmount()
  })
}

for (const surface of SURFACES) {
  test(`on ${surface} ctrl+s writes the buffer to the file and the rendered doc follows`, async ($, on) => {
    const files: Files = new Map([[A, { text: 'hello', mtimeMs: 1 }]])
    const { writes } = await started($, on, files)
    await $.command.run(mdCommand(A))
    const ui = await $.ui.mount(pane(surface))
    await ui.press({ key: 'toggle-edit' })
    await typeText(ui, 'i# New ')
    expect(await editorStatus(ui)).toMatch(/modified/)

    await save(ui)
    expect(writes).toEqual([{ path: A, text: '# New hello' }])
    expect(await editorStatus(ui)).not.toMatch(/modified/)

    await ui.press({ key: 'toggle-edit' })
    expect(await docRows(ui)).toContain('New hello')
    await ui.unmount()
  })
}

test('the edits made in the editor are marked as changes once back in the view', async ($, on) => {
  await started($, on, new Map([[A, { text: 'one', mtimeMs: 1 }]]))
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-edit' })
  await typeText(ui, 'A two')
  await save(ui)
  await ui.press({ key: 'toggle-edit' })
  expect(await header(ui)).toMatch(/1 change since you last looked/)
  await ui.unmount()
})

test('leaving with unsaved edits asks for a second e, then drops them', async ($, on) => {
  const { writes, toasts } = await started($, on, new Map([[A, { text: 'keep', mtimeMs: 1 }]]))
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-edit' })
  await typeText(ui, 'ix')

  await ui.press({ key: 'toggle-edit' })
  expect(await ui.find({ key: 'editor' })).toBeDefined()
  expect(toasts).toEqual([expect.stringMatching(/unsaved/i)])

  await ui.press({ key: 'toggle-edit' })
  expect(await ui.find({ key: 'editor' })).toBeUndefined()
  expect(writes).toEqual([])
  expect((await docRows(ui))[0]).toBe('keep')
  await ui.unmount()
})

test('a save after the file changed on disk is refused once, then overwrites', async ($, on) => {
  const files: Files = new Map([[A, { text: 'base', mtimeMs: 1 }]])
  const { writes, toasts, clock } = await started($, on, files)
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-edit' })
  await typeText(ui, 'imine ')
  files.set(A, { text: 'theirs', mtimeMs: 2 })
  await clock.advance(1000)
  expect(await header(ui)).toMatch(/changed on disk/)

  await save(ui)
  expect(writes).toEqual([])
  expect(toasts).toEqual([expect.stringMatching(/changed on disk/)])
  expect(await editorLines(ui)).toContain('mine base')

  await save(ui)
  expect(writes).toEqual([{ path: A, text: 'mine base' }])
  expect(await header(ui)).not.toMatch(/changed on disk/)
  await ui.unmount()
})

test('a clean buffer follows the file as it changes on disk', async ($, on) => {
  const files: Files = new Map([[A, { text: 'first', mtimeMs: 1 }]])
  const { clock } = await started($, on, files)
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-edit' })
  files.set(A, { text: 'second\nline', mtimeMs: 2 })
  await clock.advance(1000)
  expect((await editorLines(ui)).slice(0, 2)).toEqual(['second', 'line'])
  expect(await header(ui)).not.toMatch(/changed on disk/)
  await ui.unmount()
})

test('a doc too big to hand the editor is refused with a toast', async ($, on) => {
  const { toasts } = await started($, on, new Map([[A, { text: 'x'.repeat(95_000), mtimeMs: 1 }]]))
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-edit' })
  expect(await ui.find({ key: 'editor' })).toBeUndefined()
  expect(toasts).toEqual([expect.stringMatching(/too big/)])
  await ui.unmount()
})

test('opening another doc leaves the editor and says unsaved edits were dropped', async ($, on) => {
  const B = '/work/b.md'
  const { toasts, writes } = await started($, on, new Map([[A, { text: 'a', mtimeMs: 1 }], [B, { text: 'b', mtimeMs: 1 }]]))
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-edit' })
  await typeText(ui, 'ix')
  await $.command.run(mdCommand(B))
  expect(await ui.find({ key: 'editor' })).toBeUndefined()
  expect((await docRows(ui))[0]).toBe('b')
  expect(toasts).toEqual(['Unsaved edits to a.md were dropped.'])
  expect(writes).toEqual([])
  await ui.unmount()
})

test('the editor starts in normal mode and says so once in insert', async ($, on) => {
  await started($, on, new Map([[A, { text: 'abc', mtimeMs: 1 }]]))
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-edit' })
  await typeText(ui, 'x')
  expect((await editorLines(ui))[0]).toBe('bc')
  expect(await editorStatus(ui)).not.toMatch(/INSERT/)
  await typeText(ui, 'i')
  expect(await editorStatus(ui)).toMatch(/-- INSERT --/)
  await typeText(ui, 'jk')
  expect(await editorStatus(ui)).not.toMatch(/INSERT/)
  await ui.unmount()
})

test(':wq saves and goes back to the rendered doc', async ($, on) => {
  const { writes } = await started($, on, new Map([[A, { text: 'abc', mtimeMs: 1 }]]))
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-edit' })
  await typeText(ui, 'x:wq')
  await ui.key({ key: 'return', in: 'editor' })
  expect(writes).toEqual([{ path: A, text: 'bc' }])
  expect(await ui.find({ key: 'editor' })).toBeUndefined()
  await ui.unmount()
})

test(':q! leaves without saving; :q on a dirty buffer stays with E37', async ($, on) => {
  const { writes } = await started($, on, new Map([[A, { text: 'abc', mtimeMs: 1 }]]))
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-edit' })
  await typeText(ui, 'x:q')
  await ui.key({ key: 'return', in: 'editor' })
  expect(await editorStatus(ui)).toMatch(/E37/)
  await typeText(ui, ':q!')
  await ui.key({ key: 'return', in: 'editor' })
  expect(await ui.find({ key: 'editor' })).toBeUndefined()
  expect(writes).toEqual([])
  expect((await docRows(ui))[0]).toBe('abc')
  await ui.unmount()
})

test(':q on a clean buffer goes back to the rendered doc', async ($, on) => {
  await started($, on, new Map([[A, { text: 'abc', mtimeMs: 1 }]]))
  await $.command.run(mdCommand(A))
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'toggle-edit' })
  await typeText(ui, ':q')
  await ui.key({ key: 'return', in: 'editor' })
  expect(await ui.find({ key: 'editor' })).toBeUndefined()
  await ui.unmount()
})
