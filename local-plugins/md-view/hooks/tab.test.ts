import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const HOME = '/home/me'

const file = (name: string): FsEntry => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })
const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })

const DIRS = new Map<string, FsEntry[]>([
  ['/work', [file('README.md'), file('notes.md'), dir('docs'), dir('drafts')]],
  ['/work/docs', [file('guide.md'), file('api.md')]],
  [HOME, [file('todo.md')]],
])

/** The engine's own end of each edit: the splice applied, the cursor after it. */
const engineEdits = (on: On) => {
  const reached: string[] = []
  on('prompt.edit', (_, e) => {
    reached.push(e.inputText)
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  return reached
}

const started = async ($: Engine, on: On) => {
  const listed: string[] = []
  on('fs.list', (_, e) => {
    listed.push(e.path)
    const entries = DIRS.get(e.path)
    return entries === undefined ? { deny: `ENOENT: ${e.path}` } : { value: entries }
  })
  on('fs.stat', (_, e) => (e.path.endsWith('.md') ? { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } } : { deny: `ENOENT: ${e.path}` }))
  on('fs.read', (_, e) => ({ value: `# ${e.path}` }))
  on('fs.write', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__md-view__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // the engine's own band: nothing
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as never)
  mock.env(on, { HOME })
  mock.clock(on, { now: 1_000_000 })
  const reached = engineEdits(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  return { listed, reached }
}

const tab = (text: string, cursor = text.length) =>
  ({ origin: { kind: 'composer' }, key: { key: 'tab' }, text, cursor, start: cursor, end: cursor, inputText: '' }) as const

const typed = (text: string, ch: string) =>
  ({ origin: { kind: 'composer' }, key: { key: ch }, text, cursor: text.length, start: text.length, end: text.length, inputText: ch }) as const

const edit = ($: Engine, e: unknown) => ($ as unknown as { prompt: { edit: (e: unknown) => Promise<{ text: string; cursor: number }> } }).prompt.edit(e)

const band = (surface: (typeof SURFACES)[number]) =>
  ({
    plugin: 'md-view',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as never

const completions: { draft: string; want: string; dir: string }[] = [
  { draft: '/md R', want: '/md README.md', dir: '/work' },
  { draft: '/md no', want: '/md notes.md', dir: '/work' },
  { draft: '/md doc', want: '/md docs/', dir: '/work' },
  { draft: '/md docs/g', want: '/md docs/guide.md', dir: '/work/docs' },
  { draft: '/md /work/docs/a', want: '/md /work/docs/api.md', dir: '/work/docs' },
  { draft: '/md ~/t', want: '/md ~/todo.md', dir: HOME },
  { draft: '/md @R', want: '/md @README.md', dir: '/work' },
]

for (const { draft, want, dir } of completions) {
  test(`Tab after ${JSON.stringify(draft)} completes to ${JSON.stringify(want)}`, async ($, on) => {
    const { listed, reached } = await started($, on)
    expect(await edit($, tab(draft))).toEqual({ text: want, cursor: want.length })
    expect(listed).toEqual([dir])
    // the Tab is consumed: nothing reaches the editor
    expect(reached).toEqual([])
  })
}

const passed: string[] = ['hello', '/mdx R', '/md a.md b', '/md']

for (const draft of passed) {
  test(`Tab after ${JSON.stringify(draft)} is left to the engine`, async ($, on) => {
    const { listed, reached } = await started($, on)
    await edit($, tab(draft))
    expect(listed).toEqual([])
    expect(reached).toEqual([''])
  })
}

test('Tab with the cursor mid-draft is left to the engine', async ($, on) => {
  const { listed, reached } = await started($, on)
  await edit($, tab('/md R', 3))
  expect(listed).toEqual([])
  expect(reached).toEqual([''])
})

test('Tab in a dir that cannot be listed keeps the draft', async ($, on) => {
  const { reached } = await started($, on)
  expect(await edit($, tab('/md nowhere/x'))).toEqual({ text: '/md nowhere/x', cursor: 13 })
  expect(reached).toEqual([])
})

for (const surface of SURFACES) {
  test(`on ${surface} an ambiguous Tab lists the candidates above the prompt until the next key`, async ($, on) => {
    await started($, on)
    const quiet = await $.ui.mount(band(surface))
    expect(await quiet.find({ type: 'Text' })).toBeUndefined()
    await quiet.unmount()

    expect(await edit($, tab('/md d'))).toEqual({ text: '/md d', cursor: 5 })
    const shown = await $.ui.mount(band(surface))
    expect((await shown.find({ type: 'Text' }))?.text).toBe('docs/  drafts/')
    await shown.unmount()

    expect((await edit($, typed('/md d', 'o'))).text).toBe('/md do')
    const cleared = await $.ui.mount(band(surface))
    expect(await cleared.find({ type: 'Text' })).toBeUndefined()
    await cleared.unmount()
  })
}

const opens: { args: string; want: string }[] = [
  { args: '@README.md', want: 'Showing README.md.' },
  { args: '~/todo.md', want: `Showing ${HOME}/todo.md.` },
]

for (const { args, want } of opens) {
  test(`/md ${args} opens what Tab completed`, async ($, on) => {
    await started($, on)
    const out = await $.command.run({ command: 'md', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    expect(out.text).toBe(want)
  })
}
