import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { MdViewDoc, MdViewEditing, MdViewEditorMessage, MdViewEditorProps, MdViewView } from '../types'
import { completePath, mdArgument, splitPartial } from './complete'
import { acceptHunk, rejectHunk } from './review'
import type { Entry } from './complete'
import { snapshotPath } from './diff'
import type { Span } from './inline'
import { sanitize } from './render'
import type { ImageAt, Mark, PixelSize, Row, TableSpan, Tint } from './render'
import { resolvePath } from './snapshot'
import { clampOffset, GUTTER, headerText, jumpOffset, layoutDoc, placeImages, position, scrollStep, visibleRows } from './view'
import { cutToWidth, strWidth } from './width'

const PANE = 'md-view'
const POLL_MS = 1000
const SHOW_DOC = 'mcp__md-view__ShowDoc'

const doc = atom({ plugin: 'md-view', key: 'doc' } as const, null)
const view = atom({ plugin: 'md-view', key: 'view' } as const, null)
const candidates = atom({ plugin: 'md-view', key: 'candidates' } as const, null)
const editing = atom({ plugin: 'md-view', key: 'editing' } as const, null)

const TOP: MdViewView = { offset: 0, hunk: -1 }

// theme colors: the gutter marker of each kind of change
const MARK_COLORS: Record<Mark, string> = { added: 'success', changed: 'warning', removed: 'error' }
const MARKER = '▌'
const STICKY_BACKGROUND = 'userMessageBackground'
// theme keys: the line backgrounds of Claude Code's own edit diffs
const TINT_BACKGROUNDS: Record<Tint, string> = { added: 'diffAdded', removed: 'diffRemoved' }
// what the `n` Button takes beside the header line: `n: next` and the gap before it
const BUTTON_COLUMNS = 8
// what `a: accept` and `r: reject` take beside it, each with its gap
const REVIEW_COLUMNS = 20
// the most Tab candidates the band lists before saying how many more
const MAX_CANDIDATES = 40
// the editor's `Client` key, and what `e: edit` / `e: view` take beside the header line
const EDITOR = 'editor'
// where images are kept once converted to PNG, the one format the terminal's Image reads
const IMAGE_CACHE = '/Users/dan/Library/Caches/claude-md-images'

type Measured = PixelSize & { file: string }

// Pixel sizes by image source, and the converted file each is drawn from. Only grows: the layout cache keys on its size.
const measured = new Map<string, Measured>()
const measuring = new Set<string>()
const NO_SIZES: ReadonlyMap<string, PixelSize> = new Map()
let canShowImages: Promise<boolean> | undefined
const EDIT_COLUMNS = 8
// a Client's props and posts are bounded at 100,000 characters: room left for the rest of them
const MAX_EDIT_CHARS = 90_000

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

/** `~` and `~/...` against HOME; any other path, or one when HOME is unknown, as given. */
const expandHome = async ($: EngineInterface, path: string): Promise<string> => {
  if (path !== '~' && !path.startsWith('~/')) return path
  const home = await homeOf($)
  return home === undefined ? path : `${home}${path.slice(1)}`
}

/** The path a `/md` argument names: a leading `@` (the prompt's own file mention) dropped, `~` expanded. */
const argumentPath = ($: EngineInterface, arg: string): Promise<string> => expandHome($, arg.replace(/^@/, ''))

/** The entries of the dir at `path`; none when it cannot be listed. */
const listEntries = async ($: EngineInterface, path: string): Promise<Entry[]> => {
  try {
    return await $.fs.list(path)
  } catch {
    return []
  }
}

/** The draft with its `/md` argument (`partial`, at the draft's end) completed as far as Tab can take it. */
const completeDraft = async ($: EngineInterface, draft: string, partial: string): Promise<string> => {
  const mention = partial.startsWith('@') ? '@' : ''
  const typed = partial.slice(mention.length)
  const { dir } = splitPartial(typed)
  const entries = await listEntries($, await absolutePath($, await expandHome($, dir === '' ? '.' : dir)))
  const done = completePath(typed, entries)
  await update($, candidates, () => (done.candidates.length > 1 ? done.candidates : null))
  return draft.slice(0, draft.length - partial.length) + mention + done.text
}

const candidateText = (names: string[]): string => {
  const more = names.length - MAX_CANDIDATES
  return names.slice(0, MAX_CANDIDATES).join('  ') + (more > 0 ? `  … ${more} more` : '')
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
  // a clean editor follows the file; a dirty one keeps its edits and the header says the file moved under it
  await update($, editing, ed => (ed === null || ed.isDirty ? ed : { ...ed, saved: fresh.text }))
}

const startPolling = ($: EngineInterface) => {
  if (timer !== undefined) return
  timer = $.clock.every(POLL_MS, () => void poll($))
}

const absOf = async ($: EngineInterface, d: MdViewDoc): Promise<string> => d.absPath ?? absolutePath($, d.path)

/** Whether this terminal draws pixels (Ghostty, kitty): elsewhere an image would only hold empty rows. */
const terminalShowsImages = ($: EngineInterface): Promise<boolean> => {
  canShowImages ??= $.process
    .run(['/usr/bin/printenv', 'TERM_PROGRAM', 'TERM'])
    .then(({ stdout }) => /^(ghostty|xterm-kitty)$/m.test(stdout))
    .catch(() => false)
  return canShowImages
}

// FNV-1a: a stable file name per source, nothing cryptographic needed.
const cacheFile = (src: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < src.length; i++) hash = Math.imul(hash ^ src.charCodeAt(i), 0x01000193)
  return `${IMAGE_CACHE}/${(hash >>> 0).toString(16)}.png`
}

/** Where `src` is read from: a URL as it is, a path against the doc's own folder. */
const imageSource = (src: string, docPath: string): string =>
  /^https?:\/\//.test(src) || src.startsWith('/') ? src : `${docPath.slice(0, docPath.lastIndexOf('/') + 1)}${src}`

/** Converts and measures each image the layout has not sized yet, in the background; each one done redraws the pane. */
const measureImages = ($: EngineInterface, rows: Row[], docPath: string) => {
  const pending = rows.flatMap(r => (r.image !== undefined && r.image.rows === undefined ? [r.image.src] : []))
  for (const src of pending) {
    if (measuring.has(src)) continue
    measuring.add(src)
    const file = cacheFile(imageSource(src, docPath))
    void $.process.run([`${$.plugin.root}/bin/to-png.sh`, imageSource(src, docPath), file], { timeoutMs: 30_000 }).then(({ exitCode, stdout }) => {
      const [pixelsWide, pixelsHigh] = stdout.trim().split(' ').map(Number)
      // a failed image stays its alt until md-view reloads: retrying on every draw would rerun the helper per scroll
      if (exitCode !== 0 || !pixelsWide || !pixelsHigh) return
      measured.set(src, { pixelsWide, pixelsHigh, file })
      $.ui.invalidate('ui.render')
    })
  }
}

const openDoc = async ($: EngineInterface, path: string): Promise<Opened> => {
  const fresh = await readFile($, path)
  if (fresh instanceof Error) return { isOpened: false, error: fresh.message }

  const absPath = await absolutePath($, path)
  const current = await read($, doc)
  const isSame = current !== null && (await absOf($, current)) === absPath
  // another doc takes the pane: what was shown is what the person has seen of it
  if (current !== null && !isSame) await saveSnapshot($, await absOf($, current), current.text)
  // never seen before: what the person sees now is what later edits are marked against
  const baseline = (isSame ? current?.baseline : await loadBaseline($, absPath)) ?? fresh.text

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
  // the same doc again keeps its place; another starts at its top, out of the editor
  if (!isSame) await update($, view, () => TOP)
  if (!isSame) await leaveEditor($, current)
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

/** How the pane was laid out when a button was pressed: what picking the next change needs. */
type Frame = { width: number; windowRows: number }

/** After an accept or reject: picks the change now at `hunk` (the one after the one that went), or none when none is left. */
const pickAfter = async ($: EngineInterface, d: MdViewDoc, hunk: number, frame: Frame) => {
  const layout = layoutDoc(d.text, d.baseline, frame.width)
  const pick = Math.min(hunk, layout.hunkRows.length - 1)
  await update($, view, v => {
    if (pick < 0) return { ...(v ?? TOP), hunk: -1 }
    return { hunk: pick, offset: jumpOffset(layout.tables, layout.hunkRows[pick] as number, layout.rows.length, frame.windowRows) }
  })
}

/** Takes change `hunk` into the baseline: it is no longer marked; the file is not touched. */
const acceptChange = async ($: EngineInterface, hunk: number, frame: Frame) => {
  const shown = await read($, doc)
  if (shown === null || shown.baseline === undefined) return
  // the hunks as the pane numbers them: of the sanitized texts
  const baseline = acceptHunk(sanitize(shown.baseline), sanitize(shown.text), hunk)
  const next = { ...shown, baseline }
  await update($, doc, d => (d === null || d.path !== shown.path ? d : { ...d, baseline }))
  await pickAfter($, next, hunk, frame)
}

/** Writes the file back with change `hunk` undone, as the baseline has that part; a failed write is a toast and changes nothing. */
const rejectChange = async ($: EngineInterface, hunk: number, frame: Frame) => {
  const shown = await read($, doc)
  if (shown === null || shown.baseline === undefined) return
  const text = rejectHunk(shown.baseline, shown.text, hunk)
  try {
    await $.fs.write(shown.path, text)
  } catch (error) {
    $.ui.toast(`Cannot reject the change: ${message(error)}`)
    return
  }
  const fresh = await readFile($, shown.path)
  const next = { ...shown, text, mtimeMs: fresh instanceof Error ? shown.mtimeMs : fresh.mtimeMs, updatedAt: await $.clock.now() }
  await update($, doc, d => (d === null || d.path !== shown.path ? d : { ...d, text: next.text, mtimeMs: next.mtimeMs, updatedAt: next.updatedAt }))
  await pickAfter($, next, hunk, frame)
}

/** Ends editing; unsaved edits are dropped, with a toast naming the doc they were to. */
const leaveEditor = async ($: EngineInterface, shown: MdViewDoc | null) => {
  const was = await read($, editing)
  if (was === null) return
  await update($, editing, () => null)
  if (was.isDirty && shown !== null) $.ui.toast(`Unsaved edits to ${shown.title} were dropped.`)
}

/** `e`: the rendered doc to the source editor, or back; leaving with unsaved edits takes a second press. */
const toggleEdit = async ($: EngineInterface) => {
  const shown = await read($, doc)
  if (shown === null) return
  const now = await read($, editing)
  if (now === null) {
    if (shown.text.length > MAX_EDIT_CHARS) return $.ui.toast(`${shown.title} is too big to edit here (over ${MAX_EDIT_CHARS} characters).`)
    await update($, editing, () => ({ saved: shown.text, isDirty: false, armed: null }))
    // the keys go to the editor at once when the pane holds them; otherwise a click on it takes them
    void $.ui.focus({ requestId: PANE, key: EDITOR }).catch(() => undefined)
    return
  }
  if (now.isDirty && now.armed !== 'discard') {
    await update($, editing, (ed): MdViewEditing | null => (ed === null ? ed : { ...ed, armed: 'discard' }))
    return $.ui.toast('Unsaved edits: :w in the editor saves them, e again drops them.')
  }
  await update($, editing, () => null)
}

/**
 * Writes the editor's `text` to the file; over a file changed on disk since
 * editing began only on a second save. Says whether it was written.
 */
const saveEdit = async ($: EngineInterface, text: string): Promise<boolean> => {
  const shown = await read($, doc)
  const now = await read($, editing)
  if (shown === null || now === null) return false
  if (shown.text !== now.saved && now.armed !== 'overwrite') {
    await update($, editing, (ed): MdViewEditing | null => (ed === null ? ed : { ...ed, armed: 'overwrite' }))
    $.ui.toast(`${shown.title} changed on disk since you began editing: save again to overwrite it.`)
    return false
  }
  try {
    await $.fs.write(shown.path, text)
  } catch (error) {
    $.ui.toast(`Cannot save ${shown.title}: ${message(error)}`)
    return false
  }
  const fresh = await readFile($, shown.path)
  const mtimeMs = fresh instanceof Error ? shown.mtimeMs : fresh.mtimeMs
  const updatedAt = await $.clock.now()
  await update($, doc, d => (d === null || d.path !== shown.path ? d : { ...d, text, mtimeMs, updatedAt, isMissing: false }))
  await update($, editing, ed => (ed === null ? ed : { saved: text, isDirty: false, armed: null }))
  return true
}

const onEditorMessage = async ($: EngineInterface, data: MdViewEditorMessage) => {
  // `:q` on a clean buffer or `:q!`: the editor has already refused a `:q` with edits unsaved
  if (data.kind === 'quit') return update($, editing, () => null)
  if (data.kind === 'save') {
    const isSaved = await saveEdit($, data.text)
    if (isSaved && data.isQuit === true) await update($, editing, () => null)
    return
  }
  // any edit after a warning takes the warning back
  await update($, editing, ed => (ed === null ? ed : { ...ed, isDirty: data.isDirty, armed: null }))
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>

/** An image over the rows it holds, its row's prefix (a list marker) beside it; its alt where this surface has no Image. */
const drawImage = (elements: Elements, row: Row, image: Required<ImageAt>, key: string) => {
  const { Box, Text } = elements
  const file = measured.get(image.src)?.file
  const prefix = ' '.repeat(GUTTER) + row.spans.map(s => s.text).join('')
  if (!('Image' in elements) || file === undefined) {
    return (
      <Text key={key} dimColor wrap="truncate">
        {prefix}[image: {image.alt}]
      </Text>
    )
  }
  const { Image } = elements
  return (
    <Box key={key} flexDirection="row" height={image.rows}>
      <Text>{prefix}</Text>
      <Image source={{ file, format: 'png' }} columns={image.columns} rows={image.rows} alt={image.alt || ' '} />
    </Box>
  )
}

const drawSpan = ({ Text }: Elements, span: Span, key: string) => {
  const { text, ...style } = span
  return Object.keys(style).length === 0 ? text : (
    <Text key={key} {...style}>
      {text}
    </Text>
  )
}

/** A row's background: the sticky header's over a tint's. */
const rowBackground = (row: Row, isSticky: boolean): string | undefined =>
  isSticky ? STICKY_BACKGROUND : row.tint === undefined ? undefined : TINT_BACKGROUNDS[row.tint]

/** One doc row, gutter first; a tinted row is padded to `columns` so its background spans the pane, as GitHub's does. */
const drawRow = (elements: Elements, row: Row, isSticky: boolean, columns: number, key: string) => {
  const { Text } = elements
  const { spans, mark } = row
  const gutter = mark === undefined ? ' '.repeat(GUTTER) : [<Text key="g" color={MARK_COLORS[mark]}>{MARKER}</Text>, ' '.repeat(GUTTER - 1)]
  const background = rowBackground(row, isSticky)
  const used = GUTTER + spans.reduce((n, s) => n + strWidth(s.text), 0)
  const fill = row.tint === undefined ? '' : ' '.repeat(Math.max(0, columns - used))
  return (
    <Text key={key} wrap="truncate" {...(background === undefined ? {} : { backgroundColor: background })}>
      {gutter}
      {spans.map((s, j) => drawSpan(elements, s, `s${j}`))}
      {fill}
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
    const path = await argumentPath($, e.args.trim())
    if (path === '') return { text: 'Usage: /md <path>' }
    const opened = await openDoc($, path)
    return { text: opened.isOpened ? `Showing ${opened.path}.` : `Cannot show ${path}: ${opened.error}` }
  })

  // Tab after `/md <partial>` completes the path; any other key drops the candidates an ambiguous Tab listed
  on('prompt.edit', async ($, e, next) => {
    const isTab = e.key?.key === 'tab' && !e.key.shift && !e.key.ctrl && !e.key.meta
    const partial = isTab && e.cursor === e.text.length ? mdArgument(e.text) : undefined
    if (partial === undefined) {
      if ((await read($, candidates)) !== null) await update($, candidates, () => null)
      return next(e)
    }
    const text = await completeDraft($, e.text, partial)
    return { text, cursor: text.length }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const names = await read($, candidates)
    if (names === null || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>
          {candidateText(names)}
        </Text>
      </Box>
    )
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
    await update($, editing, () => null)
    return next(e)
  })

  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    if (e.element !== EDITOR) return next(e)
    await onEditorMessage($, e.data as MdViewEditorMessage)
    return {}
  })

  // md-view draws only the rows in its own window and scrolls them itself: no `next`, so the engine's window stays at the top
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    // the editor keeps its own window over the source: the engine's stays put
    if ((await read($, editing)) !== null) return {}
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
    const canEdit = 'Client' in elements
    const editingNow = canEdit ? await read($, editing) : null
    if (editingNow !== null && 'Client' in elements) {
      const { Client } = elements
      const windowRows = Math.max(1, e.props.scroll.bodyRows - 1)
      const isMoved = shown.text !== editingNow.saved
      const props: MdViewEditorProps = { saved: editingNow.saved, rows: windowRows, columns }
      const head = cutToWidth(`${shown.path} · editing${isMoved ? ' · changed on disk' : ''}`, Math.max(1, columns - EDIT_COLUMNS))
      return (
        <Box flexDirection="column">
          <Box key="head" flexDirection="row" gap={1}>
            <Text key="head-text" dimColor wrap="truncate">
              {head}
            </Text>
            <Button key="toggle-edit" plain hotkey="e" onPress={() => void toggleEdit($)}>
              view
            </Button>
          </Box>
          <Client key={EDITOR} module="./editor-client.tsx" props={props} height={windowRows} width={columns} />
        </Box>
      )
    }

    const headerRows = shown.isMissing ? 2 : 1
    const windowRows = Math.max(1, e.props.scroll.bodyRows - headerRows)
    const hasImages = shown.text.includes('![') || shown.text.includes('<img')
    const showsImages = hasImages && 'Image' in elements && (await terminalShowsImages($))
    const images = { sizes: showsImages ? measured : NO_SIZES, maxRows: windowRows }
    const layout = layoutDoc(shown.text, shown.baseline, Math.max(1, columns - GUTTER), images)
    if (showsImages) measureImages($, layout.rows, await absOf($, shown))
    const rowCount = layout.rows.length
    drawn = { rowCount, windowRows }
    const shownView = await read($, view)
    const offset = clampOffset(shownView?.offset ?? 0, rowCount, windowRows)
    const changes = layout.hunkRows.length
    // the change `n` picked, while it still exists
    const hunk = shownView?.hunk ?? -1
    const selected = hunk >= 0 && hunk < changes ? hunk : undefined
    const frame: Frame = { width: Math.max(1, columns - GUTTER), windowRows }
    const head = headerText(
      { path: shown.path, updated: clockText(shown.updatedAt), position: position(offset, rowCount, windowRows), changes, selected },
      columns,
      (canEdit ? EDIT_COLUMNS : 0) + (changes > 0 ? BUTTON_COLUMNS : 0) + (selected === undefined ? 0 : REVIEW_COLUMNS),
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
          {selected !== undefined && (
            <Button key="accept-change" plain hotkey="a" onPress={() => void acceptChange($, selected, frame)}>
              accept
            </Button>
          )}
          {selected !== undefined && (
            <Button key="reject-change" plain hotkey="r" onPress={() => void rejectChange($, selected, frame)}>
              reject
            </Button>
          )}
          {canEdit && (
            <Button key="toggle-edit" plain hotkey="e" onPress={() => void toggleEdit($)}>
              edit
            </Button>
          )}
        </Box>
        {shown.isMissing && (
          <Text key="missing" dimColor wrap="truncate">
            File not found — waiting for it to come back.
          </Text>
        )}
        <Box key="rows" flexDirection="column">
          {placeImages(rows).map((p, k) =>
            p.kind === 'image' ? drawImage(elements, p.shown.row, p.image, `row-${k}`) : drawRow(elements, p.shown.row, p.shown.isSticky, columns, `row-${k}`),
          )}
          {filler}
        </Box>
        {/* one row past the body: the engine then has a row to scroll, so arrows raise ui.scroll and Home/End (by contentRows) differ from a page (by bodyRows) */}
        <Text key="spare"> </Text>
      </Box>
    )
  })
}
