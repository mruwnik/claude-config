import type { Engine, Register } from 'claude-code'

import { columnsFor, split } from './parse'

// Terminal cells are about twice as tall as wide.
const CELL_ASPECT = 2

const CACHE = '/Users/dan/Library/Caches/claude-md-images'

// FNV-1a: a stable file name per source, nothing cryptographic needed.
function cacheName(src: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < src.length; i++) hash = Math.imul(hash ^ src.charCodeAt(i), 0x01000193)
  return `${CACHE}/${(hash >>> 0).toString(16)}.png`
}

type Size = { file: string; pixelsWide: number; pixelsHigh: number }

// A reply is redrawn on every scroll that moves it, so each image is converted and measured once.
const sizes = new Map<string, Promise<Size | undefined>>()

function measure($: Pick<Engine, 'process' | 'plugin'>, src: string): Promise<Size | undefined> {
  const cached = sizes.get(src)
  if (cached) return cached
  const file = cacheName(src)
  const size = $.process.run([`${$.plugin.root}/bin/to-png.sh`, src, file], { timeoutMs: 30_000 }).then(({ exitCode, stdout }) => {
    const [pixelsWide, pixelsHigh] = stdout.trim().split(' ').map(Number)
    if (exitCode === 0 && pixelsWide && pixelsHigh) return { file, pixelsWide, pixelsHigh }
    sizes.delete(src)
    return undefined
  })
  sizes.set(src, size)
  return size
}

const USAGE = `# Inline images

This terminal draws images in your replies. A line that starts with an image is drawn as a picture; an image mid-sentence or inside code stays text.

- \`![alt](url-or-absolute-path)\` alone on a line: a picture at a moderate default width.
- \`<img src="url-or-absolute-path" alt="..." width="8">\`: width in terminal columns, or a share of the pane (\`width="25%"\`).
- Text after the tag on the same line is drawn to the image's right: one such line per item makes a thumbnail list.

Use images where seeing helps (covers, charts, screenshots). For lists of things with pictures, prefer a thumbnail list (width 6-8) over full-size images. The person sees the images; you see only the links.`

async function canShowImages($: Pick<Engine, 'process'>): Promise<boolean> {
  const { stdout } = await $.process.run(['/usr/bin/printenv', 'TERM_PROGRAM', 'TERM'])
  return /^(ghostty|xterm-kitty)$/m.test(stdout)
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await canShowImages($))) return composed
    return { sections: [...composed.sections, { id: 'md-images:usage', text: USAGE, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const { text } = e.props
    if (e.surface !== 'terminal' || !(text.includes('![') || text.includes('<img'))) return next(e)
    const parts = split(text)
    if (!parts.some(part => part.kind === 'image')) return next(e)

    const { Box, Text, Markdown, Image } = $.ui.resolve(e)
    const room = Math.max(1, (e.viewport?.columns ?? 80) - 4)

    const drawn = await Promise.all(
      parts.map(async part => {
        if (part.kind === 'text') return <Markdown text={part.text} />
        const size = await measure($, part.src)
        if (!size) return <Text dimColor>[image failed to load: {part.alt}]</Text>
        const columns = columnsFor(part.width, room)
        const rows = Math.min(255, Math.max(1, Math.round((columns * size.pixelsHigh) / size.pixelsWide / CELL_ASPECT)))
        const image = <Image source={{ file: size.file, format: 'png' }} columns={columns} rows={rows} alt={part.alt} />
        if (!part.caption) return image
        return (
          <Box flexDirection="row" gap={2}>
            {image}
            <Box flexShrink={1}>
              <Markdown text={part.caption} />
            </Box>
          </Box>
        )
      }),
    )

    return (
      <Box flexDirection="row">
        <Text>{e.props.isFirstOfReply ? '● ' : '  '}</Text>
        <Box flexDirection="column" gap={1} flexShrink={1}>
          {drawn}
        </Box>
      </Box>
    )
  })
}
