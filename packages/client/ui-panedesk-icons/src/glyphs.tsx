/**
 * Monoline current-color glyphs for the Panedesk entry surfaces,
 * drawn by this project (no third-party icon set is embedded, so no
 * THIRD_PARTY_NOTICES entry is required). All glyphs share one 24-unit
 * drawing grid, a 1.5-unit stroke, round caps and joins, and inherit their
 * color from `currentColor`; only the rendered size varies (16/20/24).
 */

import type { ReactNode } from 'react'

/** Rendered sizes the entry surfaces use; the drawing grid stays 24 units. */
export type PanadeskGlyphSize = 16 | 20 | 24

/** Props every glyph accepts. */
export interface PanadeskGlyphProps {
  /** Rendered box edge in CSS pixels; defaults to the inline 16. */
  size?: PanadeskGlyphSize | undefined
  /** Optional class for consumer styling (color, margins). */
  className?: string | undefined
}

/** Frame all glyphs render into: stroke inherits `currentColor`, art is decorative. */
function Glyph({ size = 16, className, children }: PanadeskGlyphProps & { children: ReactNode }) {
  return <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none"
    xmlns="http://www.w3.org/2000/svg" aria-hidden="true"
    strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" stroke="currentColor">
    {children}
  </svg>
}

/** Stats desk: three ascending bars. Used by the Settings stats section and its main panel header. */
export const IconPanedeskStats = (props: PanadeskGlyphProps) => <Glyph {...props}>
  <path d="M5 19V13" />
  <path d="M12 19V6" />
  <path d="M19 19V10" />
  <path d="M3.5 19H20.5" />
</Glyph>

/** Workflow: two stages joined by a routed connector. Used by the workflow panel entries. */
export const IconPanedeskWorkflow = (props: PanadeskGlyphProps) => <Glyph {...props}>
  <rect x="3" y="4" width="7" height="6" rx="1.5" />
  <rect x="14" y="14" width="7" height="6" rx="1.5" />
  <path d="M10 7h1.5C12.9 7 14 8.1 14 9.5v1c0 1.4 1.1 2.5 2.5 2.5H17" />
</Glyph>

/** Subagent tree: one root and two leaves on a routing rail. Used by the header pill and right-tab. */
export const IconPanedeskSubagentTree = (props: PanadeskGlyphProps) => <Glyph {...props}>
  <circle cx="12" cy="5.5" r="2.5" />
  <circle cx="5.5" cy="18" r="2.5" />
  <circle cx="18.5" cy="18" r="2.5" />
  <path d="M12 8v3" />
  <path d="M5.5 11h13" />
  <path d="M5.5 11v4.5" />
  <path d="M18.5 11v4.5" />
</Glyph>

/** Node: a two-bay host with status dots. Used by the Settings nodes section. */
export const IconPanedeskNode = (props: PanadeskGlyphProps) => <Glyph {...props}>
  <rect x="4" y="5" width="16" height="6" rx="1.5" />
  <rect x="4" y="13" width="16" height="6" rx="1.5" />
  <path d="M7.5 8h.01" />
  <path d="M7.5 16h.01" />
  <path d="M11 8h6" />
  <path d="M11 16h6" />
</Glyph>

/** Seat grid: four equal seats. Used by the seat-overview hover affordance and menu entry. */
export const IconPanedeskSeatGrid = (props: PanadeskGlyphProps) => <Glyph {...props}>
  <rect x="4" y="4" width="7" height="7" rx="1" />
  <rect x="13" y="4" width="7" height="7" rx="1" />
  <rect x="4" y="13" width="7" height="7" rx="1" />
  <rect x="13" y="13" width="7" height="7" rx="1" />
</Glyph>

/** Seat profile: an ID card with a person mark. Used by the Settings seat-profiles section. */
export const IconPanedeskSeatProfile = (props: PanadeskGlyphProps) => <Glyph {...props}>
  <rect x="3" y="5" width="18" height="14" rx="2" />
  <circle cx="9" cy="11" r="2" />
  <path d="M6 16c.6-1.6 1.7-2.4 3-2.4s2.4.8 3 2.4" />
  <path d="M15 10.5h3.5" />
  <path d="M15 14h3.5" />
</Glyph>

/** Inbox: a tray with a settling envelope flap. Used by the session-header receipt pill. */
export const IconPanedeskInbox = (props: PanadeskGlyphProps) => <Glyph {...props}>
  <path d="M4 13l2.4-6.2A1.5 1.5 0 0 1 7.8 6h8.4a1.5 1.5 0 0 1 1.4.8L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5Z" />
  <path d="M4 13h4.8c0 1.8 1.4 3.2 3.2 3.2s3.2-1.4 3.2-3.2H20" />
</Glyph>

/** Bash: a terminal window with a prompt caret. Used by the Windows Git Bash settings row. */
export const IconPanedeskBash = (props: PanadeskGlyphProps) => <Glyph {...props}>
  <rect x="3" y="4.5" width="18" height="15" rx="2" />
  <path d="M7 10l3 2.5L7 15" />
  <path d="M12.5 15.5H17" />
</Glyph>

/** Application icon: a rounded pane carrying two chat bubbles. The product mark for Panedesk surfaces. */
export const IconPanedeskApp = (props: PanadeskGlyphProps) => <Glyph {...props}>
  <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
  <path d="M8 9.5h5.5a1.5 1.5 0 0 1 1.5 1.5v2a1.5 1.5 0 0 1-1.5 1.5H11l-2 1.8V14.5h-.5A1.5 1.5 0 0 1 7 13v-2a1.5 1.5 0 0 1 1-1.5Z" />
</Glyph>

/** One registry row: the glyph component and where the design's entry table places it. */
export interface PanadeskGlyphEntry {
  /** Stable glyph name, matching the icon manifest in the README. */
  readonly name: string
  /** The entry surface the glyph serves (design §2 placement table). */
  readonly entry: string
  /** The glyph component. */
  readonly component: (props: PanadeskGlyphProps) => ReactNode
}

/** The full glyph manifest; the tests cap it at 24 and check every size renders. */
export const PANADESK_GLYPHS: readonly PanadeskGlyphEntry[] = [
  { name: 'stats', entry: 'Settings stats desk section + main panel header', component: IconPanedeskStats },
  { name: 'workflow', entry: 'Workflow panel entries (Settings desk section + panel page)', component: IconPanedeskWorkflow },
  { name: 'subagent-tree', entry: 'Session-header pill + right-rail subagent-tree tab', component: IconPanedeskSubagentTree },
  { name: 'node', entry: 'Settings nodes section', component: IconPanedeskNode },
  { name: 'seat-grid', entry: 'Seats overview hover affordance + row menu entry', component: IconPanedeskSeatGrid },
  { name: 'seat-profile', entry: 'Settings seat-profiles section', component: IconPanedeskSeatProfile },
  { name: 'inbox', entry: 'Session-header receipt/quarantine pill', component: IconPanedeskInbox },
  { name: 'bash', entry: 'Windows Git Bash settings row', component: IconPanedeskBash },
]
