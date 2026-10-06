// node:test reporter emitting live-tests `@@test` events
// (loaded with NODE_OPTIONS="--test-reporter=<this> --test-reporter-destination=stdout").
import { basename } from 'node:path'

// Only the top-level runner loads this, before it starts test files: they, and any node they
// start, get back the NODE_OPTIONS the run inherited, so a nested `node --test` is its own.
if ('LIVE_TESTS_PREV_NODE_OPTIONS' in process.env) {
  const prev = process.env.LIVE_TESTS_PREV_NODE_OPTIONS
  if (prev === '') delete process.env.NODE_OPTIONS
  else process.env.NODE_OPTIONS = prev
  delete process.env.LIVE_TESTS_PREV_NODE_OPTIONS
}

const MARK = process.env.LIVE_TESTS_NONCE ? `@@test:${process.env.LIVE_TESTS_NONCE}` : '@@test'

const line = event => `${MARK} ${JSON.stringify(event)}\n`

const isFileEntry = data => data.nesting === 0 && data.file !== undefined && data.name === basename(data.file)

const messageOf = error => {
  const cause = error?.cause ?? error
  const frames = (cause?.stack ?? '').split('\n').slice(1).filter(line => !line.includes('(node:') && !line.includes(' node:'))
  return [cause?.message, frames.slice(0, 6).join('\n')].filter(Boolean).join('\n')
}

export default async function* liveTests(source) {
  const files = new Set()
  let filesDone = 0
  for await (const { type, data } of source) {
    if (type === 'test:enqueue' && isFileEntry(data) && !files.has(data.file)) {
      files.add(data.file)
      yield line({ event: 'progress', done: filesDone, total: files.size, unit: 'files' })
      continue
    }
    if (type === 'test:complete' && isFileEntry(data)) {
      filesDone += 1
      yield line({ event: 'progress', done: filesDone, total: files.size, unit: 'files' })
      continue
    }
    if (isFileEntry(data) || data.details?.type === 'suite') continue
    const name = data.file ? `${basename(data.file)} › ${data.name}` : data.name
    if (type === 'test:pass') {
      yield line({ event: 'result', name, outcome: data.skip || data.todo ? 'skipped' : 'passed' })
    }
    if (type === 'test:fail') {
      yield line({ event: 'result', name, outcome: 'failed', message: messageOf(data.details?.error) })
    }
  }
}
