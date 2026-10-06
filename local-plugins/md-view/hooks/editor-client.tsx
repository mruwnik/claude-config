import type { ClientModule, ClientSurface } from 'claude-code'

import type { MdViewEditorMessage, MdViewEditorProps } from '../types'
import { follow, fromText, normalize, visibleLines, toText } from './editor'
import type { Editor, Viewport } from './editor'
import { GUTTER } from './view'
import { isDirty, modeText, startVim, vimKey } from './vim'
import type { Effect, Vim } from './vim'

/** The vim buffer, and whether the hooks were last told it is dirty. */
type State = { vim: Vim; isDirty: boolean }

type Surface = ClientSurface<State>

const send = (surface: Surface, message: MdViewEditorMessage) => surface.post(message)

/** The region as laid out, or as the hooks sized it before the first layout. */
const viewportOf = (surface: Surface, props: MdViewEditorProps): Viewport => ({
  rows: surface.rows || props.rows,
  columns: surface.columns || props.columns,
})

/** `text` loaded in place of the buffer, the cursor and window kept where the new text allows. */
const reload = (ed: Editor, text: string, view: Viewport): Editor => {
  const fresh = fromText(text)
  const row = Math.min(ed.row, fresh.lines.length - 1)
  const col = Math.min(ed.col, Math.max(0, [...(fresh.lines[row] ?? '')].length - 1))
  return follow({ ...fresh, row, col, top: Math.min(ed.top, row), left: Math.min(ed.left, col) }, view)
}

/** The next state with `vim`, telling the hooks when the buffer turns dirty or clean. */
const settle = (surface: Surface, state: State, vim: Vim): State => {
  const dirty = isDirty(vim)
  if (dirty !== state.isDirty) send(surface, { kind: 'dirty', isDirty: dirty })
  return { vim, isDirty: dirty }
}

/** What an effect asks of the hooks, with the buffer's text for a save. */
const messageOf = (effect: Effect, vim: Vim): MdViewEditorMessage => {
  if (effect === 'save') return { kind: 'save', text: toText(vim.editor) }
  if (effect === 'save-quit') return { kind: 'save', text: toText(vim.editor), isQuit: true }
  return { kind: 'quit' }
}

const listen = (surface: Surface, props: MdViewEditorProps) =>
  surface.onKey(key => {
    const state = surface.state
    if (state === undefined) return
    const out = vimKey(state.vim, key, viewportOf(surface, props))
    if (out.vim !== state.vim) surface.setState(settle(surface, state, out.vim))
    if (out.effect !== undefined) send(surface, messageOf(out.effect, out.vim))
  })

/**
 * The state to draw: the first from `props.saved`; on a new `saved` a clean
 * buffer reloads it, a dirty one keeps its edits against it.
 */
const current = (surface: Surface, props: MdViewEditorProps, view: Viewport): State => {
  const state = surface.state
  if (state === undefined) {
    listen(surface, props)
    const first = { vim: startVim(props.saved), isDirty: false }
    surface.setState(first)
    return first
  }
  const saved = normalize(props.saved)
  if (state.vim.saved === saved) return state
  const editor = isDirty(state.vim) ? state.vim.editor : reload(state.vim.editor, saved, view)
  const next = settle(surface, state, { ...state.vim, editor, saved })
  surface.setState(next)
  return next
}

const MdEditor: ClientModule<MdViewEditorProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const view = viewportOf(surface, props)
  const { vim, isDirty: dirty } = current(surface, props, view)
  const { editor } = vim
  const lines = visibleLines(editor, view)
  const filler = Math.max(0, view.rows - 1 - lines.length)
  const gutter = ' '.repeat(GUTTER)
  // a block in normal mode, a bar under the character in insert mode, none while the command line has the keys
  const cursorStyle = vim.mode === 'insert' ? { underline: true } : vim.mode === 'normal' ? { inverse: true } : {}
  const mode = modeText(vim)
  const where = `ln ${editor.row + 1}, col ${editor.col + 1}${dirty ? ' · modified' : ''} · :w save · :q view`
  return (
    <Box flexDirection="column">
      <Box key="lines" flexDirection="column">
        {lines.map((line, i) => (
          <Text key={`line-${i}`} wrap="truncate">
            {gutter}
            {line.before}
            {line.cursor !== undefined && (
              <Text key="cursor" {...cursorStyle}>
                {line.cursor}
              </Text>
            )}
            {line.after ?? ''}
          </Text>
        ))}
        {Array.from({ length: filler }, (_, k) => (
          <Text key={`line-${lines.length + k}`}>{gutter}</Text>
        ))}
      </Box>
      <Text key="status" dimColor={vim.mode !== 'command'} wrap="truncate">
        {gutter}
        {mode === '' ? where : `${mode}  ${where}`}
      </Text>
    </Box>
  )
}

export default MdEditor
