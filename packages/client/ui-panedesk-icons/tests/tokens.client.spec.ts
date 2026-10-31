import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PANEDESK_COLOR_TOKENS, PANEDESK_FONT_TOKENS, PANEDESK_RADIUS_TOKENS, PANEDESK_SPACE,
} from '../src/tokens.ts'

const packageDir = dirname(fileURLToPath(import.meta.url))

describe('Panedesk design-token table', () => {
  it('references only upstream variables that actually exist (drift guard)', () => {
    for (const ref of [...PANEDESK_COLOR_TOKENS, ...PANEDESK_FONT_TOKENS, ...PANEDESK_RADIUS_TOKENS]) {
      const upstream = readFileSync(join(packageDir, '../../../../', ref.definedIn), 'utf8')
      expect(upstream, `${ref.cssName} in ${ref.definedIn}`).toMatch(new RegExp(`${ref.cssName}\\s*:`))
    }
  })

  it('keeps the new spacing tier on 4px steps', () => {
    for (const step of Object.values(PANEDESK_SPACE)) expect(step % 4).toBe(0)
    expect(PANEDESK_SPACE.x1).toBe(4)
    expect(PANEDESK_SPACE.x6).toBe(24)
  })

  it('passes the color-literal scan over the package sources', () => {
    const run = spawnSync(process.execPath, [join(packageDir, '../scripts/scan-color-literals.mjs')], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
  })
})
