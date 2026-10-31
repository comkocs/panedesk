// @vitest-environment jsdom
/**
 * ```mermaid fences render through the bundled library. A diagram the library
 * rejects falls back to the fenced source with a visible notice.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'

beforeAll(() => {
  // jsdom has no SVG layout; the renderer still parses and builds the actual SVG.
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 20))
  Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', {
    configurable: true,
    value: () => 100,
  })
  Object.defineProperty(SVGElement.prototype, 'getBBox', {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 100, height: 20 }),
  })
})

afterEach(cleanup)

const BROKEN = ['```mermaid', 'this is not a diagram', '```'].join('\n')
const DRAWN = ['```mermaid', 'graph TD', 'A-->B', '```'].join('\n')

describe('mermaid fences', () => {
  it('falls back to the fenced source with an English notice when the diagram is invalid', async () => {
    render(<MarkdownText text={BROKEN} labels={{
      code: { copyLabel: 'Copy', copiedLabel: 'Copied', mermaidFailed: 'Could not render this diagram' },
      footnotes: 'Footnotes',
    }} />)
    expect(await screen.findByText('Could not render this diagram')).toBeTruthy()
    expect(screen.getByText(/this is not a diagram/)).toBeTruthy()
  })

  it('falls back with a Chinese notice for the same invalid diagram', async () => {
    render(<MarkdownText text={BROKEN} labels={{
      code: { copyLabel: '复制', copiedLabel: '已复制', mermaidFailed: '这张图无法渲染' },
      footnotes: '脚注',
    }} />)
    expect(await screen.findByText('这张图无法渲染')).toBeTruthy()
    expect(screen.getByText(/this is not a diagram/)).toBeTruthy()
  })

  it('draws a valid diagram as SVG', async () => {
    const view = render(<MarkdownText text={DRAWN} labels={{
      code: { copyLabel: 'Copy', copiedLabel: 'Copied', mermaidFailed: 'Could not render this diagram' },
      footnotes: 'Footnotes',
    }} />)
    await waitFor(() => {
      expect(view.container.querySelector('[data-mermaid="drawn"] svg')).toBeTruthy()
    }, { timeout: 15000 })
    expect(screen.queryByText('Could not render this diagram')).toBeNull()
  }, 20000)

  it.each([
    'graph TD\nA["<img src=https://example.invalid/pixel>"]',
    '%%{init: {"securityLevel": "loose"}}%%\ngraph TD\nA-->B',
    '---\nconfig:\n  securityLevel: loose\n---\ngraph TD\nA-->B',
    'graph TD\nA-->B\nclick A "https://example.invalid/"',
  ])('keeps resource and configuration syntax inert: %s', async (source) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const view = render(<MarkdownText text={`\`\`\`mermaid\n${source}\n\`\`\``} labels={{
      code: { copyLabel: 'Copy', copiedLabel: 'Copied', mermaidFailed: 'Could not render this diagram' },
      footnotes: 'Footnotes',
    }} />)
    expect(await screen.findByText('Could not render this diagram')).toBeTruthy()
    expect(view.container.querySelector('svg, img, iframe')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRestore()
  })

  it('keeps streaming fences as code and renders independent diagrams after settlement', async () => {
    const labels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied', mermaidFailed: 'Could not render this diagram' }, footnotes: 'Footnotes' }
    const text = `${DRAWN}\n\n${DRAWN}`
    const view = render(<MarkdownText text={text} streaming labels={labels} />)
    expect(view.container.querySelector('svg')).toBeNull()
    view.rerender(<MarkdownText text={text} labels={labels} />)
    await waitFor(() => { expect(view.container.querySelectorAll('[data-mermaid="drawn"] svg')).toHaveLength(2) }, { timeout: 15000 })
    const ids = [...view.container.querySelectorAll('[data-mermaid="drawn"] svg')].map(svg => svg.id)
    expect(new Set(ids).size).toBe(2)
  }, 20000)
})
