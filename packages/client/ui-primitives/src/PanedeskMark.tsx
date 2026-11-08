import type { IconProps } from './icons/props.ts'

/**
 * Render the decorative Panedesk four-pane mark using the desktop icon artwork.
 * @param props.size - Square dimensions in pixels, defaulting to 24.
 * @param props.className - Extra class for layout placement.
 * @returns the mark SVG; its host supplies the accessible name.
 */
export function PanedeskMark({ size = 24, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 1104 1104" fill="none" aria-hidden="true">
      <rect width="1104" height="1104" rx="220.8" fill="#252526" />
      <rect x="276" y="276" width="253" height="253" rx="42.2" fill="#007ACC" />
      <rect x="575" y="276" width="253" height="253" rx="42.2" fill="#CCCCCC" />
      <rect x="276" y="575" width="253" height="253" rx="42.2" fill="#CCCCCC" />
      <rect x="575" y="575" width="253" height="253" rx="42.2" fill="#CCCCCC" />
    </svg>
  )
}
