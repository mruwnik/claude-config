import { splitSegments } from './table'

const FENCE = /^\s*(```|~~~)/
const HEADING = /^#{1,6}\s/
const LIST_ITEM = /^\s*([-*+]|\d{1,9}[.)])\s/
const BLANK = /^\s*$/

/** Past this many edits Myers gives up and treats the differing middle as replaced wholesale. */
const MAX_EDITS = 3000
/** Pairing removed with added blocks is quadratic; runs bigger than this are not paired. */
const MAX_PAIRING = 250000
const SIMILAR = 0.5

export type BlockKind = 'heading' | 'paragraph' | 'list-item' | 'code' | 'table-row'
export type TablePart = 'header' | 'delimiter' | 'body'

export type Block = {
  kind: BlockKind
  /** The block's lines as written (CR kept), without the blank lines after it. */
  text: string
  /**
   * `text` plus the blank lines after it; the first block's raw also carries any
   * blank lines before it. `blocks(t).map(b => b.raw).join('') === t`.
   */
  raw: string
  /** 0-based line of the first line of `text`. */
  line: number
  /** table-row only: which table of the document (0, 1, ...). */
  table?: number
  /** table-row only: 0 for the header row, 1 for the delimiter row, 2.. for body rows. */
  rowIndex?: number
  /** table-row only: header, delimiter or body. */
  part?: TablePart
}

export type Change =
  | { op: 'same'; block: Block }
  | { op: 'added'; block: Block }
  | { op: 'removed'; block: Block }
  | { op: 'changed'; old: Block; block: Block }

type Unit = { isBlank: true; text: string } | { isBlank: false; block: Omit<Block, 'raw'> }

const toLines = (text: string): string[] => text.split(/(?<=\n)/).filter(l => l !== '')

const unit = (kind: BlockKind, lines: string[], line: number, extra: Partial<Block> = {}): Unit => ({
  isBlank: false,
  block: { kind, text: lines.join(''), line, ...extra },
})

/** Units of a stretch of markdown that holds no table (fences are whole inside one). */
const mdUnits = (text: string, firstLine: number): Unit[] => {
  const lines = toLines(text)
  const out: Unit[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    const start = firstLine + i
    if (BLANK.test(line)) {
      out.push({ isBlank: true, text: line })
      i++
      continue
    }
    if (FENCE.test(line)) {
      const close = lines.findIndex((l, j) => j > i && FENCE.test(l))
      const end = close === -1 ? lines.length : close + 1
      out.push(unit('code', lines.slice(i, end), start))
      i = end
      continue
    }
    if (HEADING.test(line)) {
      out.push(unit('heading', [line], start))
      i++
      continue
    }
    const isItem = LIST_ITEM.test(line)
    const stop = lines.findIndex(
      (l, j) => j > i && (BLANK.test(l) || FENCE.test(l) || HEADING.test(l) || LIST_ITEM.test(l)),
    )
    const end = stop === -1 ? lines.length : stop
    out.push(unit(isItem ? 'list-item' : 'paragraph', lines.slice(i, end), start))
    i = end
  }
  return out
}

const rowPart = (rowIndex: number): TablePart => (rowIndex === 0 ? 'header' : rowIndex === 1 ? 'delimiter' : 'body')

/**
 * Splits markdown into blocks: headings, paragraphs, list items (with their
 * continuation lines), whole fenced code blocks, and table rows (each its own
 * block, tagged with its table). Table detection is `table.ts`'s `splitSegments`.
 * Blank lines are not blocks; they ride along in the previous block's `raw`.
 */
export const blocks = (text: string): Block[] => {
  const segments = splitSegments(text)
  const units: Unit[] = []
  let line = 0
  let table = 0
  for (const segment of segments) {
    if (segment.kind === 'md') {
      units.push(...mdUnits(segment.text, line))
      line += toLines(segment.text).length
      continue
    }
    const rows = toLines(segment.source)
    rows.forEach((row, rowIndex) =>
      units.push(unit('table-row', [row], line + rowIndex, { table, rowIndex, part: rowPart(rowIndex) })),
    )
    line += rows.length
    table++
  }
  return attachBlanks(units)
}

/** Folds blank units into the `raw` of the block before them (leading ones into the first block). */
const attachBlanks = (units: Unit[]): Block[] => {
  const out: Block[] = []
  let leading = ''
  for (const u of units) {
    if (!u.isBlank) {
      out.push({ ...u.block, raw: leading + u.block.text })
      leading = ''
      continue
    }
    const last = out[out.length - 1]
    if (last === undefined) leading += u.text
    else last.raw += u.text
  }
  return out
}

/** What blocks are compared by: line endings and trailing whitespace do not count. */
export const normalize = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
    .trimEnd()

type Edit = { op: 'del'; oldIndex: number } | { op: 'ins'; newIndex: number } | { op: 'same'; oldIndex: number; newIndex: number }

/**
 * Myers O(ND) shortest edit script over int arrays. Returns undefined when it
 * needs more than `limit` edits. (Imperative inside: it is the hot loop.)
 */
const myers = (a: number[], b: number[], limit: number): Edit[] | undefined => {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, limit)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found === -1; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
        ? (v[offset + k + 1] as number)
        : (v[offset + k - 1] as number) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found === -1) return undefined
  const edits: Edit[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const snap = trace[d] as Int32Array
    const at = (k: number): number => snap[k + d + 1] as number
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      edits.push({ op: 'same', oldIndex: x, newIndex: y })
    }
    if (x === prevX) edits.push({ op: 'ins', newIndex: prevY })
    else edits.push({ op: 'del', oldIndex: prevX })
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    x--
    y--
    edits.push({ op: 'same', oldIndex: x, newIndex: y })
  }
  return edits.reverse()
}

const words = (text: string): Set<string> => new Set(normalize(text).toLowerCase().split(/\s+/).filter(w => w !== ''))

/** Dice coefficient of the word sets. */
const similarity = (a: string, b: string): number => {
  const wa = words(a)
  const wb = words(b)
  if (wa.size + wb.size === 0) return 1
  const shared = [...wa].filter(w => wb.has(w)).length
  return (2 * shared) / (wa.size + wb.size)
}

/** Settles one run of removed and added blocks: similar ones pair up as `changed`, in order; removed before added between pairs. */
const settle = (removed: Block[], added: Block[]): Change[] => {
  const isPairable = removed.length * added.length <= MAX_PAIRING
  const out: Change[] = []
  let r = 0
  let a = 0
  const flush = (rEnd: number, aEnd: number) => {
    out.push(...removed.slice(r, rEnd).map((block): Change => ({ op: 'removed', block })))
    out.push(...added.slice(a, aEnd).map((block): Change => ({ op: 'added', block })))
  }
  for (let j = 0; j < added.length && isPairable; j++) {
    const block = added[j] as Block
    const hit = removed.findIndex((o, k) => k >= r && o.kind === block.kind && similarity(o.text, block.text) >= SIMILAR)
    if (hit === -1) continue
    flush(hit, j)
    out.push({ op: 'changed', old: removed[hit] as Block, block })
    r = hit + 1
    a = j + 1
  }
  flush(removed.length, added.length)
  return out
}

/**
 * Compares two block lists (by normalized text). The result follows the NEW
 * document: `same`/`added`/`changed` carry the new block, `removed` blocks sit
 * where they used to be, `changed` also carries the old block. An empty `old`
 * is a first view with no baseline: everything is `added` (see `compare`).
 */
export const diffBlocks = (old: Block[], next: Block[]): Change[] => {
  const oldKeys = old.map(b => normalize(b.text))
  const newKeys = next.map(b => normalize(b.text))
  let head = 0
  while (head < old.length && head < next.length && oldKeys[head] === newKeys[head]) head++
  let tail = 0
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    oldKeys[old.length - 1 - tail] === newKeys[next.length - 1 - tail]
  )
    tail++

  const ids = new Map<string, number>()
  const intern = (key: string): number => {
    const known = ids.get(key)
    if (known !== undefined) return known
    ids.set(key, ids.size)
    return ids.size - 1
  }
  const a = oldKeys.slice(head, old.length - tail).map(intern)
  const b = newKeys.slice(head, next.length - tail).map(intern)
  const script: Edit[] = myers(a, b, MAX_EDITS) ?? [
    ...a.map((_, oldIndex): Edit => ({ op: 'del', oldIndex })),
    ...b.map((_, newIndex): Edit => ({ op: 'ins', newIndex })),
  ]

  const out: Change[] = next.slice(0, head).map((block): Change => ({ op: 'same', block }))
  let removed: Block[] = []
  let added: Block[] = []
  const close = () => {
    out.push(...settle(removed, added))
    removed = []
    added = []
  }
  for (const e of script) {
    if (e.op === 'del') removed.push(old[head + e.oldIndex] as Block)
    else if (e.op === 'ins') added.push(next[head + e.newIndex] as Block)
    else {
      close()
      out.push({ op: 'same', block: next[head + e.newIndex] as Block })
    }
  }
  close()
  out.push(...next.slice(next.length - tail).map((block): Change => ({ op: 'same', block })))
  return out
}

/**
 * Changes of `text` against the snapshot `baseline`. No baseline (undefined, or
 * only blank lines: the person has not seen this doc before) means nothing is
 * marked: every block is `same`.
 */
export const compare = (baseline: string | undefined, text: string): Change[] => {
  const current = blocks(text)
  if (baseline === undefined || baseline.trim() === '') return current.map((block): Change => ({ op: 'same', block }))
  return diffBlocks(blocks(baseline), current)
}

/** Number of change hunks: a run of consecutive non-same changes is one. */
export const countChanges = (changes: Change[]): number =>
  changes.reduce((n, c, i) => (c.op !== 'same' && changes[i - 1]?.op !== undefined && changes[i - 1]?.op !== 'same' ? n : c.op !== 'same' ? n + 1 : n), 0)

/** 32-bit FNV-1a of a string, as 8 hex digits. */
export const fnv1a = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Where the snapshot of the doc at `absPath` is kept. */
export const snapshotPath = (home: string, absPath: string): string => `${home}/.claude/md-view/snapshots/${fnv1a(absPath)}.md`
