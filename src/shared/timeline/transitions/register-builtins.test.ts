// @vitest-environment node

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vite-plus/test'
import { transitionRegistry } from './index'

describe('built-in transition timing support', () => {
  it('does not advertise spring timing for transitions', () => {
    for (const definition of transitionRegistry.getDefinitions()) {
      expect(definition.supportedTimings, definition.id).not.toContain('spring')
    }
  })

  it('keeps the Agent contract aligned with the registered presentation IDs', () => {
    const contractSource = readFileSync(
      new URL('../../../../headless/lib/contract.mjs', import.meta.url),
      'utf8',
    )
    const listSource = /export const TRANSITION_PRESENTATIONS = \[([\s\S]*?)\n\]/u.exec(
      contractSource,
    )?.[1]
    expect(listSource).toBeTruthy()
    const contractIds = [...(listSource ?? '').matchAll(/'([^']+)'/gu)].map((match) => match[1])

    expect([...contractIds].sort()).toEqual([...transitionRegistry.getIds()].sort())
  })
})
