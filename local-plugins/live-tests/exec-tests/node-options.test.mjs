// Runs real suite commands: `node --test exec-tests/*.test.mjs` (the plugin test kit cannot start processes).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bashCommand } from '../hooks/command.ts'

const EMITTERS = fileURLToPath(new URL('../emitters', import.meta.url))

const INNER = `import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
test('tiny passes', () => {
  writeFileSync(process.env.PROBE_INNER, JSON.stringify(process.env.NODE_OPTIONS ?? null))
})
`

// The outer suite's own test spawns node --test, as a CLI under test or a test of a test runner would.
// Node's own NODE_TEST_CONTEXT is dropped, as such a test must (it silences a nested runner either way);
// NODE_OPTIONS is passed on as the test file has it.
const OUTER = `import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
test('outer spawns a nested node --test', () => {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env
  const spec = spawnSync(process.execPath, ['--test', 'inner/tiny.test.mjs'], { encoding: 'utf8', env })
  const dot = spawnSync(process.execPath, ['--test', '--test-reporter=dot', 'inner/tiny.test.mjs'], { encoding: 'utf8', env })
  writeFileSync(process.env.PROBE_OUTER, JSON.stringify({ stdout: spec.stdout, dotStatus: dot.status, dotStderr: dot.stderr }))
})
`

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-tests-exec-'))
  mkdirSync(join(dir, 'inner'))
  writeFileSync(join(dir, 'inner', 'tiny.test.mjs'), INNER)
  writeFileSync(join(dir, 'outer.test.mjs'), OUTER)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test outer.test.mjs' } }))
  return dir
}

const ARGVS = [
  ['node', '--test', 'outer.test.mjs'],
  ['npm', 'test', '--silent'],
  ['bash', '-c', 'node --test outer.test.mjs'],
]

const INHERITED = [undefined, '--no-warnings']

for (const argv of ARGVS) {
  for (const inherited of INHERITED) {
    test(`${argv.join(' ')} with NODE_OPTIONS ${inherited ?? 'unset'}: a nested node --test is left alone, the outer run still reported`, () => {
      const dir = fixture()
      const files = { log: join(dir, 'run.log'), events: join(dir, 'run.events') }
      const command = bashCommand({ cwd: dir, argv, runner: 'node-test', env: {}, emittersDir: EMITTERS, files, nonce: 'n0', labels: { run: 'r0', agentId: null, agentName: null } })
      const { NODE_OPTIONS: _drop, ...base } = process.env
      const env = {
        ...Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith('NODE_TEST'))),
        ...(inherited === undefined ? {} : { NODE_OPTIONS: inherited }),
        PROBE_INNER: join(dir, 'inner.json'),
        PROBE_OUTER: join(dir, 'outer.json'),
      }
      const ran = spawnSync('bash', ['-c', command], { env, encoding: 'utf8' })
      assert.equal(ran.status, 0, readFileSync(files.log, 'utf8'))
      const outer = JSON.parse(readFileSync(join(dir, 'outer.json'), 'utf8'))
      assert.match(outer.stdout, /tiny passes/)
      assert.doesNotMatch(outer.stdout, /@@test/)
      assert.equal(outer.dotStatus, 0, outer.dotStderr)
      assert.equal(JSON.parse(readFileSync(join(dir, 'inner.json'), 'utf8')), inherited ?? null)
      const events = readFileSync(files.events, 'utf8')
      assert.match(events, /@@test:n0 \{"event":"result","name":"outer\.test\.mjs › outer spawns a nested node --test","outcome":"passed"\}/)
      assert.match(events, /@@test:n0 \{"event":"exit","code":0\}/)
    })
  }
}
