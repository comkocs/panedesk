// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import {
  IconPanedeskApp, PANEDESK_GLYPHS,
  type PanedeskGlyphProps,
} from '../src/glyphs.tsx'

/** Render one glyph and return its svg element. */
function svgOf(Component: (props: PanedeskGlyphProps) => ReactNode, size?: PanedeskGlyphProps['size']) {
  const { container } = render(size === undefined ? <Component /> : <Component size={size} />)
  return container.querySelector('svg')!
}

describe('Panedesk glyph set', () => {
  it('stays within the 24-glyph budget with unique names', () => {
    expect(PANEDESK_GLYPHS.length).toBeLessThanOrEqual(24)
    expect(new Set(PANEDESK_GLYPHS.map(entry => entry.name)).size).toBe(PANEDESK_GLYPHS.length)
    for (const entry of PANEDESK_GLYPHS) expect(entry.entry).toMatch(/./)
  })

  it('renders every glyph at 16, 20, and 24 with currentColor and no fill', () => {
    for (const entry of PANEDESK_GLYPHS) {
      for (const size of [16, 20, 24] as const) {
        const svg = svgOf(entry.component, size)
        expect(svg.getAttribute('width'), `${entry.name}@${size}`).toBe(String(size))
        expect(svg.getAttribute('height'), `${entry.name}@${size}`).toBe(String(size))
        expect(svg.getAttribute('viewBox'), `${entry.name}@${size}`).toBe('0 0 24 24')
        expect(svg.getAttribute('stroke'), `${entry.name}@${size}`).toBe('currentColor')
        expect(svg.getAttribute('fill'), `${entry.name}@${size}`).toBe('none')
        expect(svg.getAttribute('aria-hidden'), `${entry.name}@${size}`).toBe('true')
        expect(svg.childNodes.length, `${entry.name}@${size}`).toBeGreaterThan(0)
      }
    }
  })

  it('defaults the app mark to the inline 16 size and keeps it currentColor', () => {
    const svg = svgOf(IconPanedeskApp)
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('height')).toBe('16')
    expect(svg.getAttribute('stroke')).toBe('currentColor')
  })
})
