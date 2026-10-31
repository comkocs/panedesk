/**
 * The Panedesk design-token table for the Panedesk entry surfaces. Color, font,
 * and radius entries are references to upstream DSH theme variables — the
 * table records which upstream token each new surface consumes, it does not
 * mint color values. Spacing is the one genuinely new tier: the upstream
 * theme ships no unified spacing variables, so the values the new panels
 * already use in CSS Modules (4/8/12/16/24) get names here.
 */

/** One consumed upstream variable: the CSS name and where the upstream value lives. */
export interface UpstreamTokenRef {
  /** Upstream CSS custom property name, consumed as `var(<name>)`. */
  readonly cssName: string
  /** Upstream source file that defines the value, relative to the repo root. */
  readonly definedIn: string
}

/** Semantic color aliases the new entry surfaces consume; values stay upstream. */
export const PANEDESK_COLOR_TOKENS: readonly UpstreamTokenRef[] = [
  { cssName: '--dsw-alias-bg-base', definedIn: 'packages/client/ui-theme/src/styles/design-platform.css' },
  { cssName: '--dsw-alias-bg-layer-1', definedIn: 'packages/client/ui-theme/src/styles/design-platform.css' },
  { cssName: '--dsw-alias-bg-layer-2', definedIn: 'packages/client/ui-theme/src/styles/design-platform.css' },
  { cssName: '--dsw-alias-border-l2', definedIn: 'packages/client/ui-theme/src/styles/design-platform.css' },
  { cssName: '--dsw-alias-border-l3', definedIn: 'packages/client/ui-theme/src/styles/design-platform.css' },
  { cssName: '--dsw-alias-label-primary', definedIn: 'packages/client/ui-theme/src/styles/design-platform.css' },
  { cssName: '--dsw-alias-label-secondary', definedIn: 'packages/client/ui-theme/src/styles/design-platform.css' },
  { cssName: '--dsw-alias-label-tertiary', definedIn: 'packages/client/ui-theme/src/styles/design-platform.css' },
  { cssName: '--dsw-alias-brand-primary', definedIn: 'packages/client/ui-theme/src/styles/design-platform.css' },
  { cssName: '--dsw-alias-menu-icon', definedIn: 'packages/client/ui-theme/src/styles/design-platform.css' },
]

/** Typography tokens the new surfaces consume (font shorthand values). */
export const PANEDESK_FONT_TOKENS: readonly UpstreamTokenRef[] = [
  { cssName: '--dsw-font-base-16', definedIn: 'packages/client/ui-theme/src/styles/gradient-shadow-text.css' },
  { cssName: '--dsw-font-s-14', definedIn: 'packages/client/ui-theme/src/styles/gradient-shadow-text.css' },
  { cssName: '--dsw-font-m-18', definedIn: 'packages/client/ui-theme/src/styles/gradient-shadow-text.css' },
  { cssName: '--dsw-font-l-20', definedIn: 'packages/client/ui-theme/src/styles/gradient-shadow-text.css' },
]

/** Corner-radius tokens the new surfaces consume. */
export const PANEDESK_RADIUS_TOKENS: readonly UpstreamTokenRef[] = [
  { cssName: '--dsw-radius-xs', definedIn: 'packages/client/ui-theme/src/styles/base.css' },
  { cssName: '--dsw-radius-sm', definedIn: 'packages/client/ui-theme/src/styles/base.css' },
  { cssName: '--dsw-radius-md', definedIn: 'packages/client/ui-theme/src/styles/base.css' },
  { cssName: '--dsw-radius-lg', definedIn: 'packages/client/ui-theme/src/styles/base.css' },
]

/**
 * Spacing tier — the one new scale. Named by 4px steps matching the values
 * the new panels' CSS Modules already use; consumed as literal values because
 * the upstream theme declares no spacing variables to reference.
 */
export const PANEDESK_SPACE = {
  /** 4px — inline gaps between a label and its trailing copy. */
  x1: 4,
  /** 8px — gaps between sibling actions. */
  x2: 8,
  /** 12px — block padding inside list rows. */
  x3: 12,
  /** 16px — vertical padding of a settings row / section body. */
  x4: 16,
  /** 24px — separation between a row's text block and its actions. */
  x6: 24,
} as const

/** Type of the spacing tier for consumers that annotate handles. */
export type PanedeskSpace = typeof PANEDESK_SPACE
