// Runs a real suite command and reads the labels back from the process it starts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bashCommand } from '../hooks/command.ts'

const NAMES = ['LIVE_TESTS_RUN', 'LIVE_TESTS_AGENT_ID', 'LIVE_TESTS_AGENT_NAME']

const CASES = [
  [{ run: 'toolu_1', agentId: null, agentName: null }, { LIVE_TESTS_RUN: 'toolu_1' }],
  [{ run: 'toolu_1', agentId: 'a1', agentName: null }, { LIVE_TESTS_RUN: 'toolu_1', LIVE_TESTS_AGENT_ID: 'a1' }],
  [
    { run: "r'$(x)", agentId: '$(touch /tmp/no)', agentName: "bob's mate" },
    { LIVE_TESTS_RUN: "r'$(x)", LIVE_TESTS_AGENT_ID: '$(touch /tmp/no)', LIVE_TESTS_AGENT_NAME: "bob's mate" },
  ],
]

for (const [labels, expected] of CASES) {
  test(`a suite's process sees its labels: ${JSON.stringify(labels)}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-tests-labels-'))
    const out = join(dir, 'env.json')
    const script = `const pick = ${JSON.stringify(NAMES)}.filter(k => k in process.env); require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.fromEntries(pick.map(k => [k, process.env[k]]))))`
    const files = { log: join(dir, 'run.log'), events: join(dir, 'run.events') }
    const command = bashCommand({ cwd: dir, argv: [process.execPath, '-e', script], runner: 'events', env: {}, emittersDir: '/none', files, nonce: 'n0', labels })
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !NAMES.includes(k)))
    const ran = spawnSync('bash', ['-c', command], { env, encoding: 'utf8' })
    assert.equal(ran.status, 0, readFileSync(files.log, 'utf8'))
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), expected)
  })
}
