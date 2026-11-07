import { describe, expect, it } from 'vitest'
import { resolveTelemetryPatch } from '@panedesk/dsh-app-boot'

const session = new Set(['session-telemetry-otel'])

describe('resolveTelemetryPatch', () => {
  it('preserves the configured telemetry mode when the hard-disable switch is unset or empty', () => {
    expect(resolveTelemetryPatch(undefined, session)).toEqual([])
    expect(resolveTelemetryPatch('', session)).toEqual([])
  })

  it('disables on ANY non-empty value, including falsy-looking ones', () => {
    for (const value of ['1', '0', 'false', 'no']) {
      expect(resolveTelemetryPatch(value, session)).toEqual([{ id: 'session-telemetry-otel', disabled: true }])
    }
  })

  it('is trivially satisfied by a composition without the telemetry row', () => {
    // A custom profile need not mount telemetry: nothing exports, so the
    // privacy switch has nothing to disable and generates no patch.
    expect(resolveTelemetryPatch('1', new Set())).toEqual([])
    expect(resolveTelemetryPatch(undefined, new Set())).toEqual([])
  })

  it('disables present product analytics rows and leaves absent ones untouched', () => {
    const present = new Set(['desktop-product-telemetry', 'product-analytics', 'unrelated'])
    expect(resolveTelemetryPatch('1', present)).toEqual([
      { id: 'desktop-product-telemetry', disabled: true },
      { id: 'product-analytics', disabled: true },
    ])
    expect(resolveTelemetryPatch(undefined, present)).toEqual([])
    expect(resolveTelemetryPatch('1', new Set(['product-analytics']))).toEqual([
      { id: 'product-analytics', disabled: true },
    ])
  })
})
