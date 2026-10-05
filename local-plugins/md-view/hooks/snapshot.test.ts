import { expect, test } from 'claude-code/testing'

import { resolvePath } from './snapshot'

const cases: { cwd: string; path: string; want: string }[] = [
  { cwd: '/work', path: 'a.md', want: '/work/a.md' },
  { cwd: '/work/', path: './docs/../a.md', want: '/work/a.md' },
  { cwd: '/work/x', path: '../a.md', want: '/work/a.md' },
  { cwd: '/work', path: '/abs//dir/./a.md', want: '/abs/dir/a.md' },
  { cwd: '/', path: '../../a.md', want: '/a.md' },
  { cwd: '/work', path: 'C:\\docs\\a.md', want: 'C:\\docs\\a.md' },
]

for (const { cwd, path, want } of cases) {
  test(`resolvePath(${cwd}, ${path}) is ${want}`, () => {
    expect(resolvePath(cwd, path)).toBe(want)
  })
}
