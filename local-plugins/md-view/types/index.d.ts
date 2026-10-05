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

declare module 'claude-code' {
  interface PluginState {
    'md-view': {
      doc: MdViewDoc | null
      view: MdViewView | null
      /** What the last Tab after `/md <partial>` could complete to, when more than one; null once another key is pressed. */
      candidates: string[] | null
    }
  }
}
