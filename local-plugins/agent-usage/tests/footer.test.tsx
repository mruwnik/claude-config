import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { COMMAND, startSession, usageText, world } from './world'

/** The engine's own footer modes beneath, as one Text; with `runs`, live-tests beneath too: its run column right of the modes. */
const engineModes = (on: On, runs: readonly string[] = []) =>
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (runs.length === 0) return <Text>{e.props.modes.join(' & ')}</Text>
    return (
      <Box flexDirection="row">
        <Text>{e.props.modes.join(' & ')}</Text>
        <Box flexDirection="column">
          {runs.map(run => (
            <Text key={run}>{run}</Text>
          ))}
        </Box>
      </Box>
    )
  })

const SURFACES = ['terminal', 'desktop'] as const

const footerTexts = async ($: Engine, surface: (typeof SURFACES)[number]) => {
  const ui = await $.ui.mount({ plugin: 'agent-usage', surface, component: 'SessionMode', props: { modes: ['focus'] } })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map(t => t.text)
}

for (const surface of SURFACES) {
  test(`${surface}: by default the footer keeps what is beneath and adds a column of the rows over 500M or 30% after it (claude at 500M is not)`, async ($, on) => {
    const { clock, statuses } = world(on)
    engineModes(on)
    await startSession($)
    await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
    await clock.advance(5000)
    expect(await footerTexts($, surface)).toEqual(['focus', '⚠ main  3.0G  0%'])
    expect(statuses.filter(text => text !== undefined)).toEqual([])
  })
}

test('with footer alerts, the footer is left as the hooks beneath drew it', { options: { footer: 'alerts' } }, async ($, on) => {
  const { clock } = world(on)
  engineModes(on)
  await startSession($)
  await clock.advance(5000)
  expect(await footerTexts($, 'terminal')).toEqual(['focus'])
})

test('with footer off, there is no column and no status line', { options: { footer: 'off' } }, async ($, on) => {
  const { clock, statuses } = world(on)
  engineModes(on)
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(5000)
  expect(await footerTexts($, 'terminal')).toEqual(['focus'])
  expect(statuses.filter(text => text !== undefined)).toEqual([])
})

test('/agent-usage says where the footer column went', async ($, on) => {
  const { clock } = world(on)
  engineModes(on)
  await startSession($)
  await clock.advance(5000)
  await footerTexts($, 'terminal')
  expect(await usageText($)).toMatch(/Footer: always, live-tests not beneath this time \(outer, or not drawing\)\./)
})

test('agent-usage outer: its column, keyed trailing:agent-usage, comes after live-tests runs beneath', async ($, on) => {
  const { clock } = world(on)
  engineModes(on, ['▶ unit (bg) 3/9 33% 12s'])
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(5000)
  const ui = await $.ui.mount({ plugin: 'agent-usage', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const column = await ui.find({ key: 'trailing:agent-usage' })
  await ui.unmount()
  expect(texts).toEqual(['focus', '▶ unit (bg) 3/9 33% 12s', '⚠ main  3.0G  0%'])
  expect(column?.type).toBe('Box')
})

test('with no row over the floor, no column is drawn at all', async ($, on) => {
  const { clock } = world(on)
  engineModes(on)
  await startSession($)
  await clock.advance(5000)
  const ui = await $.ui.mount({ plugin: 'agent-usage', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const column = await ui.find({ key: 'trailing:agent-usage' })
  await ui.unmount()
  expect(texts).toEqual(['focus'])
  expect(column).toBeUndefined()
})

test('the footer floor comes from footerMinMemoryMB and footerMinCpuPercent', { options: { footerMinMemoryMB: 100, footerMinCpuPercent: 50 } }, async ($, on) => {
  const { clock } = world(on)
  engineModes(on)
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(5000)
  expect(await footerTexts($, 'terminal')).toEqual(['focus', '⚠ main    3.0G  0%', '  claude  500M  0%'])
})
