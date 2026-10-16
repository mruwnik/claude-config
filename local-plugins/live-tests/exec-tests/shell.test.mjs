// The Bash tool runs commands in the user's login shell, so a suite command must behave the same under zsh as bash.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { suiteCommand } from '../hooks/command.ts'

const eventsIn = path =>
  Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter(line => line.startsWith('@@test:n0 '))
      .map(line => line.slice('@@test:n0 '.length))
      .map(json => [/"event":"(\w+)"/.exec(json)[1], JSON.parse(json)]),
  )

const CASES = [
  ['bash', ['true'], 0],
  ['bash', ['false'], 1],
  ['bash', ['live-tests-no-such-command'], 127],
  ['zsh', ['true'], 0],
  ['zsh', ['false'], 1],
  ['zsh', ['live-tests-no-such-command'], 127],
]

for (const [shell, argv, code] of CASES) {
  test(`under ${shell}, ${argv[0]} records exit ${code} and the suite's pid`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-tests-shell-'))
    const files = { log: join(dir, 'run.log'), events: join(dir, 'run.events') }
    const labels = { run: 'r0', agentId: null, agentName: null }
    const command = suiteCommand([{ cwd: dir, argv, runner: 'events', env: {}, emittersDir: '/none', files, nonce: 'n0', labels }])
    const ran = spawnSync(shell, ['-c', command], { encoding: 'utf8' })
    const events = eventsIn(files.events)
    assert.equal(ran.status, code)
    assert.equal(events.exit.code, code)
    assert.equal(typeof events.start.pid, 'number')
  })
}

test('a missing cwd records a failing exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-tests-shell-'))
  const files = { log: join(dir, 'run.log'), events: join(dir, 'run.events') }
  const labels = { run: 'r0', agentId: null, agentName: null }
  const command = suiteCommand([{ cwd: join(dir, 'nope'), argv: ['true'], runner: 'events', env: {}, emittersDir: '/none', files, nonce: 'n0', labels }])
  spawnSync('zsh', ['-c', command], { encoding: 'utf8' })
  assert.notEqual(eventsIn(files.events).exit.code, 0)
})
