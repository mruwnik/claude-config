const MARKDOWN_IMAGE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/
// An optional list marker, the tag, then an optional caption drawn to the image's right.
const HTML_IMAGE = /^\s*(?:[-*+]\s+)?<img\s([^>]*?)\/?>(.*)$/
const ATTRIBUTE = /(\w+)\s*=\s*"([^"]*)"/g
const DEFAULT_COLUMNS = 30

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'image'; alt: string; src: string; width?: string; caption?: string }

function parseImage(line: string): Part | undefined {
  const markdown = line.match(MARKDOWN_IMAGE)
  if (markdown) return { kind: 'image', alt: markdown[1] || ' ', src: markdown[2] }
  const html = line.match(HTML_IMAGE)
  if (!html) return undefined
  const attributes = Object.fromEntries([...html[1].matchAll(ATTRIBUTE)].map(([, name, value]) => [name, value]))
  if (!attributes.src) return undefined
  return {
    kind: 'image',
    alt: attributes.alt || ' ',
    src: attributes.src,
    width: attributes.width,
    caption: html[2].trim() || undefined,
  }
}

// Only an image starting its own line, outside code fences, is drawn: splitting mid-line breaks the
// surrounding markdown, and an image inside backticks is meant literally.
export function split(text: string): Part[] {
  const parts: Part[] = []
  let pending: string[] = []
  let isInFence = false
  const flush = () => {
    if (pending.join('').trim()) parts.push({ kind: 'text', text: pending.join('\n') })
    pending = []
  }
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) isInFence = !isInFence
    const image = isInFence ? undefined : parseImage(line)
    if (!image) {
      pending.push(line)
      continue
    }
    flush()
    parts.push(image)
  }
  flush()
  return parts
}

// `width` is terminal columns ("8") or a share of the room ("25%"); absent, a moderate default.
export function columnsFor(width: string | undefined, room: number): number {
  const percent = width?.match(/^(\d+(?:\.\d+)?)%$/)
  const wanted = percent ? (room * Number(percent[1])) / 100 : Number(width) || DEFAULT_COLUMNS
  return Math.max(1, Math.min(room, Math.round(wanted)))
}
