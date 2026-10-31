/** Lazy, strict Mermaid rendering with offline-only source and SVG validation. */
import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { CodeBlock } from './CodeBlock.tsx'
import type { CodeBlockProps } from './CodeBlock.tsx'

/** Localized labels and the body of one Mermaid fence. */
export interface MermaidFenceProps {
  /** Fence body without its display newline. */
  readonly code: string
  /** Notice shown when rendering or safety validation fails. */
  readonly failedLabel: string
  /** Copy-button idle label. */
  readonly copyLabel: string
  /** Copy-button confirmation label. */
  readonly copiedLabel: string
  /** Shared code toolbar retained when the diagram falls back to source. */
  readonly toolbarLabels?: CodeBlockProps['toolbarLabels']
}

type MermaidState =
  | { readonly code: string; readonly kind: 'drawn'; readonly svg: string }
  | { readonly code: string; readonly kind: 'failed' }

/** Reject resource syntax before Mermaid can mount its temporary rendering DOM. */
function offlineSource(code: string): boolean {
  return !/(?:https?:|data:|javascript:|\/\/|url\s*\(|@import|\b(?:img|icon)\s*:|%%\s*\{|^\s*---)/im.test(code)
}

/** Admit only inert SVG whose resource references point inside the diagram. */
function offlineSvg(svg: string): boolean {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (document.documentElement.localName !== 'svg' || document.querySelector('parsererror, script, foreignObject, image')) return false
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (/^on/i.test(attribute.name)) return false
      if (attribute.localName === 'href' && !attribute.value.startsWith('#')) return false
    }
  }
  return !/(?:@import|url\s*\(\s*["']?\s*(?!#)[^\s])/i.test(svg)
}

/**
 * Draw a local diagram or retain its source with the localized failure notice.
 * @param props - the source and localized code-block labels.
 * @returns the diagram, pending source, or failed source.
 */
export function MermaidFence(props: MermaidFenceProps): ReactNode {
  const { code, failedLabel, copyLabel, copiedLabel } = props
  const reactId = useId().replaceAll(':', '')
  const [state, setState] = useState<MermaidState>()

  useEffect(() => {
    let current = true
    const draw = async (): Promise<void> => {
      try {
        if (!offlineSource(code)) throw new Error('external resources or diagram configuration are not allowed')
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          htmlLabels: false,
          suppressErrorRendering: true,
          secure: ['securityLevel', 'startOnLoad', 'htmlLabels', 'themeCSS', 'fontFamily'],
        })
        const rendered = await mermaid.render(`mermaid-${reactId}`, code)
        if (!offlineSvg(rendered.svg)) throw new Error('diagram contains external or active content')
        if (current) setState({ code, kind: 'drawn', svg: rendered.svg })
      } catch (_error: unknown) {
        // A rejected source, import, or renderer remains available as a copyable code block.
        if (current) setState({ code, kind: 'failed' })
      }
    }
    void draw()
    return () => { current = false }
  }, [code, reactId])

  if (state?.code === code && state.kind === 'drawn') {
    return <div data-mermaid="drawn" dangerouslySetInnerHTML={{ __html: state.svg }} />
  }
  const failed = state?.code === code && state.kind === 'failed'
  return (
    <div data-mermaid={failed ? 'failed' : 'pending'}>
      {failed ? <p role="status">{failedLabel}</p> : null}
      <CodeBlock code={`${code}\n`} lang="mermaid" copyLabel={copyLabel} copiedLabel={copiedLabel} toolbarLabels={props.toolbarLabels} />
    </div>
  )
}
