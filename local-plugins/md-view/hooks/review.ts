import { compare } from './diff'
import type { Block, Change } from './diff'

/** Where a piece of a rebuilt doc came from: the old text, or the new (an unchanged block is the new text's). */
type Source = 'old' | 'new'
type Piece = { raw: string; block: Block; source: Source }

/** Each change's hunk number (a run of consecutive non-same changes is one, from 0); undefined for `same`. */
const hunkNumbers = (changes: Change[]): (number | undefined)[] => {
  let hunks = -1
  return changes.map((c, i) => {
    if (c.op === 'same') return undefined
    if (i === 0 || changes[i - 1]?.op === 'same') hunks++
    return hunks
  })
}

/** What one change puts in the rebuilt doc: its new side or its old side; nothing where that side has no block. */
const pieceOf = (c: Change, isNew: boolean): Piece | undefined => {
  switch (c.op) {
    case 'same':
      return { raw: c.block.raw, block: c.block, source: 'new' }
    case 'added':
      return isNew ? { raw: c.block.raw, block: c.block, source: 'new' } : undefined
    case 'removed':
      return isNew ? undefined : { raw: c.block.raw, block: c.block, source: 'old' }
    case 'changed':
      return isNew ? { raw: c.block.raw, block: c.block, source: 'new' } : { raw: c.old.raw, block: c.old, source: 'old' }
  }
}

const isTight = (a: Block, b: Block): boolean => a.kind === b.kind && (a.kind === 'list-item' || a.kind === 'table-row')

/**
 * Where two pieces meet that were not next to each other in one text, the
 * blank line between blocks is made sure of (none between two list items or
 * two table rows), so a paragraph put back never runs into the one before it.
 */
const seam = (before: string, prev: Block, next: Block): string => {
  const ended = before.endsWith('\n') ? before : `${before}\n`
  return ended.endsWith('\n\n') || isTight(prev, next) ? ended : `${ended}\n`
}

/** The doc made of each change's new side where `isNew(hunk)`, its old side elsewhere. */
const rebuild = (changes: Change[], isNew: (hunk: number | undefined) => boolean): string => {
  const hunks = hunkNumbers(changes)
  let out = ''
  let prev: Piece | undefined
  let isSkipped = false
  changes.forEach((c, i) => {
    const piece = pieceOf(c, isNew(hunks[i]))
    if (piece === undefined) {
      isSkipped = true
      return
    }
    const isSeam = prev !== undefined && (isSkipped || prev.source !== piece.source)
    out = (isSeam && prev !== undefined ? seam(out, prev.block, piece.block) : out) + piece.raw
    prev = piece
    isSkipped = false
  })
  // the doc's last blocks were left out: the blank lines that came before them go too
  return isSkipped ? out.replace(/\n+$/, '\n') : out
}

/** The baseline with hunk `hunk` of `text`'s changes taken in: that change is no longer marked. */
export const acceptHunk = (baseline: string, text: string, hunk: number): string =>
  rebuild(compare(baseline, text), h => h === hunk)

/** `text` with hunk `hunk` of its changes undone: that part back as the baseline has it. */
export const rejectHunk = (baseline: string, text: string, hunk: number): string =>
  rebuild(compare(baseline, text), h => h !== hunk)
