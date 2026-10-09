import { expect, test } from 'claude-code/testing'

import { columnsFor, split } from './parse'
import type { Part } from './parse'

const fence = '```'
const url = 'https://example.com/a.png'

const splitCases: Array<{ name: string; md: string; want: Part[] }> = [
  { name: 'no images is one text part', md: 'just text', want: [{ kind: 'text', text: 'just text' }] },
  {
    name: 'markdown image alone on its line',
    md: `before\n![cover](${url})\nafter`,
    want: [
      { kind: 'text', text: 'before' },
      { kind: 'image', alt: 'cover', src: url },
      { kind: 'text', text: 'after' },
    ],
  },
  { name: 'image mid-sentence stays text', md: `see ![x](${url}) here`, want: [{ kind: 'text', text: `see ![x](${url}) here` }] },
  { name: 'image in inline code stays text', md: `\`![x](${url})\``, want: [{ kind: 'text', text: `\`![x](${url})\`` }] },
  {
    name: 'image inside a code fence stays text',
    md: `${fence}\n![x](${url})\n${fence}`,
    want: [{ kind: 'text', text: `${fence}\n![x](${url})\n${fence}` }],
  },
  {
    name: 'img tag with width and caption, list marker dropped',
    md: `- <img src="${url}" alt="Fool Night" width="6"> **Fool Night**: 4.0`,
    want: [{ kind: 'image', alt: 'Fool Night', src: url, width: '6', caption: '**Fool Night**: 4.0' }],
  },
  { name: 'img tag without src stays text', md: '<img alt="x">', want: [{ kind: 'text', text: '<img alt="x">' }] },
]
for (const { name, md, want } of splitCases) test(`split: ${name}`, () => expect(split(md)).toEqual(want))

const columnCases: Array<{ name: string; width: string | undefined; room: number; want: number }> = [
  { name: 'absent is the default', width: undefined, room: 100, want: 30 },
  { name: 'default shrinks to the room', width: undefined, room: 20, want: 20 },
  { name: 'columns as given', width: '8', room: 100, want: 8 },
  { name: 'percent of the room', width: '25%', room: 80, want: 20 },
  { name: 'never wider than the room', width: '500', room: 80, want: 80 },
  { name: 'nonsense falls back to the default', width: 'big', room: 100, want: 30 },
]
for (const { name, width, room, want } of columnCases) test(`columnsFor: ${name}`, () => expect(columnsFor(width, room)).toBe(want))
