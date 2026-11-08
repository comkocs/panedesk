import type { IconProps } from './icons/props.ts'
import { PanedeskMark } from './PanedeskMark.tsx'

/** Display options for the Panedesk brand wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading four-pane mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the Panedesk name with an optional leading product mark.
 * @param props.size - Height in pixels, defaulting to 24.
 * @param props.className - Extra class for layout placement.
 * @param props.includeMark - Whether to include the leading four-pane mark.
 * @returns the decorative wordmark SVG; its host supplies the accessible name.
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const width = includeMark ? 132 : 100
  return (
    <svg width={(size * width) / 24} height={size} className={className} viewBox={`0 0 ${width} 24`} aria-hidden="true">
      {includeMark && <PanedeskMark />}
      <text x={includeMark ? 32 : 0} y="18" fill="currentColor" fontFamily="inherit" fontSize="18" fontWeight="600">Panedesk</text>
    </svg>
  )
}
