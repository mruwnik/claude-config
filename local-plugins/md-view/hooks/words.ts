import { appendSpan } from './inline'
import type { Span } from './inline'

/** Theme keys: the word backgrounds of Claude Code's own edit diffs. */
export const ADDED_WORD = 'diffAddedWord'
export const REMOVED_WORD = 'diffRemovedWord'

/** Past this many token pairs the LCS table is too big: the whole old text is removed and the whole new text added. */
const MAX_CELLS = 250_000

/** A word or a run of whitespace, in the style of the span it came from. */
const tokens = (spans: Span[]): Span[] => spans.flatMap(s => s.text.split(/(\s+)/).filter(t => t !== '').map(text => ({ ...s, text })))

const removed = (t: Span): Span => ({ ...t, backgroundColor: REMOVED_WORD, strikethrough: true })
const added = (t: Span): Span => ({ ...t, backgroundColor: ADDED_WORD })

/** The pairs of equal tokens of a longest common subsequence, as [old index, new index] in order. */
const lcsPairs = (a: string[], b: string[]): [number, number][] => {
  // lengths[i][j]: the LCS length of a[i..] and b[j..]
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lengths[i] as number[]
    const below = lengths[i + 1] as number[]
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number)
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i++, j++])
      continue
    }
    if ((lengths[i + 1]?.[j] as number) >= (lengths[i]?.[j + 1] as number)) i++
    else j++
  }
  return pairs
}

/**
 * The new inline text with the old one diffed into it word by word, as
 * GitHub's rich diff shows a changed paragraph: kept words as they are, each
 * run of removed words struck on the removed background just before the run
 * of added words (on the added background) that replaced it.
 */
export const wordDiff = (old: Span[], next: Span[]): Span[] => {
  const a = tokens(old)
  const b = tokens(next)
  const out: Span[] = []
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    a.forEach(t => appendSpan(out, removed(t)))
    b.forEach(t => appendSpan(out, added(t)))
    return out
  }
  let i = 0
  let j = 0
  const pairs: [number, number][] = [...lcsPairs(a.map(t => t.text), b.map(t => t.text)), [a.length, b.length]]
  for (const [pi, pj] of pairs) {
    for (; i < pi; i++) appendSpan(out, removed(a[i] as Span))
    for (; j < pj; j++) appendSpan(out, added(b[j] as Span))
    if (j < b.length) appendSpan(out, b[j] as Span)
    i++
    j++
  }
  return out
}
