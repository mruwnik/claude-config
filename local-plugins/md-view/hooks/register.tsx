import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { MdViewDoc, MdViewView } from '../types'
import { snapshotPath } from './diff'
import type { Span } from './inline'
import type { Mark, TableSpan } from './render'
import { resolvePath } from './snapshot'
import { clampOffset, GUTTER, headerText, jumpOffset, layoutDoc, position, scrollStep, visibleRows } from './view'

const PANE = 'md-view'
const POLL_MS = 1000
const SHOW_DOC = 'mcp__md-view__ShowDoc'

const doc = atom({ plugin: 'md-view', key: 'doc' } as const, null)
const view = atom({ plugin: 'md-view', key: 'view' } as const, null)

const TOP: MdViewView = { offset: 0, hunk: -1 }

// theme colors: the gutter marker of each kind of change
const MARK_COLORS: Record<Mark, string> = { added: 'success', changed: 'warning', removed: 'error' }
const MARKER = '▌'
const STICKY_BACKGROUND = 'userMessageBackground'
// what the `n` Button takes beside the header line: `n: next` and the gap before it
const BUTTON_COLUMNS = 8

type Opened = { isOpened: true; path: string } | { isOpened: false; error: string }

const basename = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

const pad = (n: number): string => String(n).padStart(2, '0')

export const clockText = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

type Fresh = { text: string; mtimeMs: number }

const readFile = async ($: EngineInterface, path: string): Promise<Fresh | Error> => {
  try {
    const { mtimeMs, kind } = await $.fs.stat(path)
    if (kind !== 'file') return new Error(`${path} is not a file`)
    return { text: await $.fs.read(path), mtimeMs }
  } catch (error) {
    return new Error(message(error))
  }
}

const homeOf = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    return await $.env.get('HOME')
  } catch {
    return undefined
  }
}

/** The absolute path of a doc as the person or the model gave it, against the session's cwd; as given when the cwd is unknown. */
const absolutePath = async ($: EngineInterface, path: string): Promise<string> => {
  if (path.startsWith('/')) return resolvePath('', path)
  try {
    return resolvePath(await $.session.cwd(), path)
  } catch {
    return path
  }
}

/** The text saved when the person last stopped viewing the doc at `absPath`; undefined when there is none or it cannot be read. */
const loadBaseline = async ($: EngineInterface, absPath: string): Promise<string | undefined> => {
  const home = await homeOf($)
  if (home === undefined) return undefined
  try {
    return await $.fs.read(snapshotPath(home, absPath))
  } catch {
    return undefined
  }
}

/** Keeps `text` as the baseline of the doc at `absPath`; a failure is ignored (the next open just has no marks). */
const saveSnapshot = async ($: EngineInterface, absPath: string, text: string): Promise<void> => {
  const home = await homeOf($)
  if (home === undefined) return
  try {
    await $.fs.write(snapshotPath(home, absPath), text)
  } catch {
    // no baseline is a view without marks: nothing to tell the person
  }
}

let timer: Timer | undefined

const stopPolling = () => {
  timer?.cancel()
  timer = undefined
}

const poll = async ($: EngineInterface) => {
  const shown = await read($, doc)
  if (shown === null) return stopPolling()

  try {
    const { mtimeMs } = await $.fs.stat(shown.path)
    if (mtimeMs === shown.mtimeMs && !shown.isMissing) return
  } catch {
    if (shown.isMissing) return
    return void (await update($, doc, d => (d === null ? d : { ...d, isMissing: true })))
  }

  const fresh = await readFile($, shown.path)
  if (fresh instanceof Error) return
  const now = await $.clock.now()
  await update($, doc, d => (d === null || d.path !== shown.path ? d : { ...d, ...fresh, updatedAt: now, isMissing: false }))
}

const startPolling = ($: EngineInterface) => {
  if (timer !== undefined) return
  timer = $.clock.every(POLL_MS, () => void poll($))
}

const absOf = async ($: EngineInterface, d: MdViewDoc): Promise<string> => d.absPath ?? absolutePath($, d.path)

const openDoc = async ($: EngineInterface, path: string): Promise<Opened> => {
  const fresh = await readFile($, path)
  if (fresh instanceof Error) return { isOpened: false, error: fresh.message }

  const absPath = await absolutePath($, path)
  const current = await read($, doc)
  const isSame = current !== null && (await absOf($, current)) === absPath
  // another doc takes the pane: what was shown is what the person has seen of it
  if (current !== null && !isSame) await saveSnapshot($, await absOf($, current), current.text)
  const baseline = isSame ? current?.baseline : await loadBaseline($, absPath)

  const next: MdViewDoc = {
    path,
    absPath,
    title: basename(path),
    ...(baseline === undefined ? {} : { baseline }),
    ...fresh,
    updatedAt: await $.clock.now(),
    isMissing: false,
  }
  await update($, doc, () => next)
  // the same doc again keeps its place; another starts at its top
  if (!isSame) await update($, view, () => TOP)
  await $.ui.open({ id: PANE, title: next.title })
  startPolling($)
  return { isOpened: true, path }
}

/**
 * What the last draw laid out: all a scroll step needs (the scroll hook does
 * not see the pane's width). null while no doc is drawn; undefined before the
 * first draw (cold, after a hot reload).
 */
type Drawn = { rowCount: number; windowRows: number }
let drawn: Drawn | null | undefined

/** Moves md-view's window for a scroll the engine would have made: the engine's own window never moves. */
const scrollBy = async ($: EngineInterface, e: { by: number; bodyRows: number; contentRows: number }) => {
  const known = drawn
  await update($, view, v => {
    const current = v ?? TOP
    // no draw yet to clamp against: step anyway, the next draw clamps
    const offset = known == null ? Math.max(0, current.offset + e.by) : scrollStep(e, current.offset, known.rowCount, known.windowRows)
    return offset === current.offset ? current : { ...current, offset }
  })
}

/** Moves the window to the change after the one `n` last went to (the first at first), wrapping round. */
const jumpToNextChange = async ($: EngineInterface, hunkRows: number[], tables: TableSpan[], rowCount: number, windowRows: number) => {
  if (hunkRows.length === 0) return
  await update($, view, v => {
    const hunk = ((v ?? TOP).hunk + 1) % hunkRows.length
    return { hunk, offset: jumpOffset(tables, hunkRows[hunk] as number, rowCount, windowRows) }
  })
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>

const drawSpan = ({ Text }: Elements, span: Span, key: string) => {
  const { text, ...style } = span
  return Object.keys(style).length === 0 ? text : (
    <Text key={key} {...style}>
      {text}
    </Text>
  )
}

const drawRow = (elements: Elements, spans: Span[], mark: Mark | undefined, isSticky: boolean, key: string) => {
  const { Text } = elements
  const gutter = mark === undefined ? ' '.repeat(GUTTER) : [<Text key="g" color={MARK_COLORS[mark]}>{MARKER}</Text>, ' '.repeat(GUTTER - 1)]
  return (
    <Text key={key} wrap="truncate" {...(isSticky ? { backgroundColor: STICKY_BACKGROUND } : {})}>
      {gutter}
      {spans.map((s, j) => drawSpan(elements, s, `s${j}`))}
    </Text>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'md',
      description: 'Show a markdown file in a live-updating pane',
      argumentHint: '<path>',
    })
    await $.tool.register({
      name: 'ShowDoc',
      description:
        'Opens a markdown file rendered in a side pane for the user to read, and keeps it live as the file changes. ' +
        'The user sees the rendered document; you get only a short confirmation, not the content.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Markdown file, relative to the working directory or absolute' } },
        required: ['path'],
      },
    })
    // a hot reload resets `timer` but keeps the shown doc in $.state: resume polling it
    if ((await read($, doc)) !== null) startPolling($)
    return next(e)
  })

  on('command.run', { command: 'md' }, async ($, e) => {
    const path = e.args.trim()
    if (path === '') return { text: 'Usage: /md <path>' }
    const opened = await openDoc($, path)
    return { text: opened.isOpened ? `Showing ${opened.path}.` : `Cannot show ${path}: ${opened.error}` }
  })

  on('tool.call', { tool: SHOW_DOC }, async ($, e) => {
    const path = typeof e.path === 'string' ? e.path.trim() : ''
    if (path === '') return { result: 'ShowDoc needs a path.', isError: true }
    const opened = await openDoc($, path)
    return opened.isOpened
      ? { result: `Showing ${opened.path} in the side pane.` }
      : { result: `Cannot show ${path}: ${opened.error}`, isError: true }
  })

  // the session ends with the pane open: what is shown is what the person has seen of it, as when the pane is closed
  on('session.end', async ($, e, next) => {
    const shown = await read($, doc)
    if (shown !== null) await saveSnapshot($, await absOf($, shown), shown.text)
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    stopPolling()
    const shown = await read($, doc)
    // the person stops viewing what is shown: that is what the next open compares against
    if (shown !== null) await saveSnapshot($, await absOf($, shown), shown.text)
    drawn = undefined
    await update($, doc, () => null)
    await update($, view, () => null)
    return next(e)
  })

  // md-view draws only the rows in its own window and scrolls them itself: no `next`, so the engine's window stays at the top
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (drawn === null) return next(e)
    if (drawn === undefined && (await read($, doc)) === null) return next(e)
    await scrollBy($, e)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const shown = await read($, doc)
    if (shown === null) {
      drawn = null
      return (
        <Box flexDirection="column">
          <Text dimColor>No doc open — /md &lt;path&gt;</Text>
        </Box>
      )
    }

    const columns = e.props.bodyColumns
    const layout = layoutDoc(shown.text, shown.baseline, Math.max(1, columns - GUTTER))
    const headerRows = shown.isMissing ? 2 : 1
    const windowRows = Math.max(1, e.props.scroll.bodyRows - headerRows)
    const rowCount = layout.rows.length
    drawn = { rowCount, windowRows }
    const offset = clampOffset((await read($, view))?.offset ?? 0, rowCount, windowRows)
    const changes = layout.hunkRows.length
    const head = headerText(
      { path: shown.path, updated: clockText(shown.updatedAt), position: position(offset, rowCount, windowRows), changes },
      columns,
      changes > 0 ? BUTTON_COLUMNS : 0,
    )
    const rows = visibleRows(layout, offset, windowRows)
    const filler = Array.from({ length: windowRows - rows.length }, (_, k) => (
      <Text key={`row-${rows.length + k}`}>{' '.repeat(GUTTER)}</Text>
    ))
    return (
      <Box flexDirection="column">
        <Box key="head" flexDirection="row" gap={1}>
          <Text key="head-text" dimColor wrap="truncate">
            {head}
          </Text>
          {changes > 0 && (
            <Button
              key="next-change"
              plain
              hotkey="n"
              onPress={() => void jumpToNextChange($, layout.hunkRows, layout.tables, rowCount, windowRows)}
            >
              next
            </Button>
          )}
        </Box>
        {shown.isMissing && (
          <Text key="missing" dimColor wrap="truncate">
            File not found — waiting for it to come back.
          </Text>
        )}
        <Box key="rows" flexDirection="column">
          {rows.map((r, k) => drawRow(elements, r.row.spans, r.row.mark, r.isSticky, `row-${k}`))}
          {filler}
        </Box>
        {/* one row past the body: the engine then has a row to scroll, so arrows raise ui.scroll and Home/End (by contentRows) differ from a page (by bodyRows) */}
        <Text key="spare"> </Text>
      </Box>
    )
  })
}
