/**
 * Public face of the Panedesk icon package: the app mark, the glyph set, and
 * the design-token table. This is a static browser library like ui-primitives
 * — no Cordis plugin half, no slots; consumers import components directly.
 */

export {
  IconPanedeskApp,
  IconPanedeskBash,
  IconPanedeskInbox,
  IconPanedeskNode,
  IconPanedeskSeatGrid,
  IconPanedeskSeatProfile,
  IconPanedeskStats,
  IconPanedeskSubagentTree,
  IconPanedeskWorkflow,
  PANEDESK_GLYPHS,
} from './glyphs.tsx'
export type { PanedeskGlyphEntry, PanedeskGlyphProps, PanedeskGlyphSize } from './glyphs.tsx'
export {
  PANEDESK_COLOR_TOKENS,
  PANEDESK_FONT_TOKENS,
  PANEDESK_RADIUS_TOKENS,
  PANEDESK_SPACE,
} from './tokens.ts'
export type { PanedeskSpace, UpstreamTokenRef } from './tokens.ts'
