/** A directory entry as completion reads it: `$.fs.list`'s name and kind. */
export type Entry = { name: string; kind: 'file' | 'dir' | 'other' }

/** What Tab puts in place of the partial path, and every name it could have been (dirs with their slash). */
export type Completion = { text: string; candidates: string[] }

const MARKDOWN = /\.(md|markdown|mdx)$/i
const MD_ARGUMENT = /^\/md\s+(\S*)$/

/** The partial path of a draft that is `/md` and one argument being typed; undefined for any other draft. */
export const mdArgument = (draft: string): string | undefined => MD_ARGUMENT.exec(draft)?.[1]

/** `docs/gu` → the dir to list as typed (`docs/`) and the stem of the name being typed (`gu`). */
export const splitPartial = (partial: string): { dir: string; stem: string } => {
  const cut = partial.lastIndexOf('/') + 1
  return { dir: partial.slice(0, cut), stem: partial.slice(cut) }
}

const commonPrefix = (names: string[]): string =>
  names.reduce((prefix, name) => {
    let i = 0
    while (i < prefix.length && prefix[i] === name[i]) i++
    return prefix.slice(0, i)
  })

// smart case: a stem with a capital matches exactly, a lowercase one either case
const matcher = (stem: string) => {
  if (stem !== stem.toLowerCase()) return (name: string) => name.startsWith(stem)
  return (name: string) => name.toLowerCase().startsWith(stem)
}

const isOffered = (entry: Entry): boolean => entry.kind === 'dir' || MARKDOWN.test(entry.name)

const byName = (a: string, b: string): number => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()]
  return x < y ? -1 : x > y ? 1 : 0
}

/** Completes `partial` against the entries of its dir: directories and markdown files, dotfiles only for a dot stem. */
export const completePath = (partial: string, entries: Entry[]): Completion => {
  const { dir, stem } = splitPartial(partial)
  const matches = matcher(stem)
  const offered = entries.filter(e => isOffered(e) && matches(e.name) && (stem.startsWith('.') || !e.name.startsWith('.')))
  const dirs = offered.filter(e => e.kind === 'dir').map(e => `${e.name}/`).sort(byName)
  const files = offered.filter(e => e.kind !== 'dir').map(e => e.name).sort(byName)
  const candidates = [...dirs, ...files]
  if (candidates.length === 0) return { text: partial, candidates }
  const prefix = commonPrefix(candidates)
  return { text: dir + (prefix.length >= stem.length ? prefix : stem), candidates }
}
