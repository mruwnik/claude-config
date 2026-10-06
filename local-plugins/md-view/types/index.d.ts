export type MdViewDoc = {
  /** The path as the person or the model gave it (relative to cwd, or absolute). */
  path: string
  /** The file's basename: the pane's title. */
  title: string
  /** `path` made absolute against the session's cwd when the doc was opened; names its snapshot. */
  absPath?: string
  /**
   * The text the person saw when they last stopped viewing this file (its snapshot), read when
   * the doc is opened and kept while it is open: live edits are marked against it. Absent when
   * there is none, and then nothing is marked.
   */
  baseline?: string
  /** The file's text as last read; kept when the file goes missing. */
  text: string
  /** The mtime seen at the last read. */
  mtimeMs: number
  /** When the text was last read, ms since the epoch. */
  updatedAt: number
  /** True while the file cannot be statted or read; polling goes on. */
  isMissing: boolean
}

/** Where md-view's own window sits over the doc's rows: md-view scrolls them itself, the engine's window never moves. */
export type MdViewView = {
  /** The doc row at the window's top, from 0; clamped to the doc when drawn. */
  offset: number
  /** The change hunk the last `n` went to, -1 before the first. */
  hunk: number
}

/** The source editor, while the pane shows it in place of the rendered doc. */
export type MdViewEditing = {
  /** The text the editor's buffer is clean against: the file as it was when editing began, as last saved, or as last read while the buffer was clean. */
  saved: string
  /** The editor holds edits not yet saved, as its last post said. */
  isDirty: boolean
  /** What a second press goes ahead with: a save over a file changed on disk, or leaving with unsaved edits. */
  armed: 'overwrite' | 'discard' | null
}

/** What the editor's `Client` module draws from. */
export type MdViewEditorProps = {
  /** The text its buffer is clean against; a new one reloads a clean buffer. */
  saved: string
  /** The region's size until the surface has laid it out. */
  rows: number
  columns: number
}

/**
 * What the editor's `Client` module posts to the hooks: the buffer turned
 * dirty or clean; a save (`:w`, ^S; `isQuit` for `:wq`, which leaves once it
 * is written); leaving (`:q` on a clean buffer, or `:q!` dropping its edits).
 */
export type MdViewEditorMessage =
  | { kind: 'dirty'; isDirty: boolean }
  | { kind: 'save'; text: string; isQuit?: boolean }
  | { kind: 'quit' }

declare module 'claude-code' {
  interface PluginState {
    'md-view': {
      doc: MdViewDoc | null
      view: MdViewView | null
      editing: MdViewEditing | null
      /** What the last Tab after `/md <partial>` could complete to, when more than one; null once another key is pressed. */
      candidates: string[] | null
    }
  }
}
