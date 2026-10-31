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
  PANADESK_GLYPHS,
} from './glyphs.tsx'
export type { PanadeskGlyphEntry, PanadeskGlyphProps, PanadeskGlyphSize } from './glyphs.tsx'
export {
  PANADESK_COLOR_TOKENS,
  PANADESK_FONT_TOKENS,
  PANADESK_RADIUS_TOKENS,
  PANADESK_SPACE,
} from './tokens.ts'
export type { PanadeskSpace, UpstreamTokenRef } from './tokens.ts'
