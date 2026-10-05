import { expect, test } from 'claude-code/testing'

import { completePath, mdArgument, splitPartial } from './complete'
import type { Entry } from './complete'

const file = (name: string): Entry => ({ name, kind: 'file' })
const dir = (name: string): Entry => ({ name, kind: 'dir' })

const ENTRIES: Entry[] = [
  file('README.md'),
  file('readme-old.markdown'),
  file('notes.md'),
  file('notes.txt'),
  file('main.ts'),
  dir('docs'),
  dir('drafts'),
  dir('.git'),
  file('.hidden.md'),
]

const splits: { partial: string; dir: string; stem: string }[] = [
  { partial: '', dir: '', stem: '' },
  { partial: 'REA', dir: '', stem: 'REA' },
  { partial: 'docs/', dir: 'docs/', stem: '' },
  { partial: 'docs/gu', dir: 'docs/', stem: 'gu' },
  { partial: '/abs/x/y', dir: '/abs/x/', stem: 'y' },
  { partial: '~/n', dir: '~/', stem: 'n' },
]

for (const { partial, dir, stem } of splits) {
  test(`splitPartial(${JSON.stringify(partial)}) is ${dir} + ${stem}`, () => {
    expect(splitPartial(partial)).toEqual({ dir, stem })
  })
}

const completions: { partial: string; text: string; candidates: string[] }[] = [
  // one match: the whole name
  { partial: 'no', text: 'notes.md', candidates: ['notes.md'] },
  // one dir: the name and its slash, ready for the next Tab
  { partial: 'doc', text: 'docs/', candidates: ['docs/'] },
  // several: as far as they agree, and every candidate listed (dirs first)
  { partial: 'd', text: 'd', candidates: ['docs/', 'drafts/'] },
  { partial: 'R', text: 'README.md', candidates: ['README.md'] },
  // markdown only: notes.txt and main.ts are never offered
  { partial: 'm', text: 'm', candidates: [] },
  // the dir part is kept as typed
  { partial: 'sub/no', text: 'sub/notes.md', candidates: ['notes.md'] },
  // dotfiles only when the stem asks for them
  { partial: '', text: '', candidates: ['docs/', 'drafts/', 'notes.md', 'readme-old.markdown', 'README.md'] },
  { partial: '.', text: '.', candidates: ['.git/', '.hidden.md'] },
  // smart case: a lowercase stem matches either case; one with a capital matches exactly
  { partial: 'rea', text: 'rea', candidates: ['readme-old.markdown', 'README.md'] },
  { partial: 'readme-', text: 'readme-old.markdown', candidates: ['readme-old.markdown'] },
]

for (const { partial, text, candidates } of completions) {
  test(`completePath(${JSON.stringify(partial)}) completes to ${JSON.stringify(text)}`, () => {
    expect(completePath(partial, ENTRIES)).toEqual({ text, candidates })
  })
}

test('completePath offers a symlink as a file when it is markdown', () => {
  expect(completePath('li', [{ name: 'link.md', kind: 'other' }])).toEqual({ text: 'link.md', candidates: ['link.md'] })
})

const args: { draft: string; want: string | undefined }[] = [
  { draft: '/md ', want: '' },
  { draft: '/md docs/gu', want: 'docs/gu' },
  { draft: '/md   a.md', want: 'a.md' },
  { draft: '/md', want: undefined },
  { draft: '/mdx a', want: undefined },
  { draft: '/md a.md b', want: undefined },
  { draft: 'see /md a', want: undefined },
]

for (const { draft, want } of args) {
  test(`mdArgument(${JSON.stringify(draft)}) is ${JSON.stringify(want)}`, () => {
    expect(mdArgument(draft)).toBe(want)
  })
}
