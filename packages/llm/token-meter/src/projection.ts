/**
 * Pure client-safe token-projection vocabulary.
 *
 * @module @panedesk/dsh-token-meter/projection
 */

/**
 * Durable cumulative provider usage for a complete session log.
 *
 * The four buckets are disjoint. In particular, reasoning tokens are already
 * included in `outputTokens` and are not accumulated again.
 */
export interface TokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * Approximate context occupancy for a status display.
 *
 * The fields, when present, are deliberately NOT one atomic request
 * observation: each is a last-wins record of a different moment. Switching
 * models can therefore pair a fresh capacity with the previous route's
 * pressure until the next request reports usage. This is an intentional trade
 * — the value is a user-facing reference, not a billing or gating input. See
 * the token-meter README for the full rationale.
 */
export interface ContextPressureProjection {
  /**
   * Provider-reported prompt size of the most recent request: uncached input
   * plus cache reads and writes. Response output is excluded, so this does not
   * grow as the current turn streams. Absent until a provider reports usage.
   */
  pressureTokens?: number
  /**
   * What the NEXT request's prompt would cost: {@link pressureTokens} plus the
   * heuristic repricing of everything the surface gained or lost since that
   * sample. Only the delta is estimated, so the figure stays anchored to the
   * provider while still reacting the moment a compaction shadows a span —
   * which `pressureTokens` alone cannot do, since compaction reports no usage
   * of its own. Absent until a provider reports usage.
   */
  projectedTokens?: number
  /** Newest recorded route capacity; absent when no adapter advertised one. */
  contextWindow?: number
}

/** One named prompt contribution; deferred tool definitions do not occupy context. */
export interface ContextBreakdownItem {
  name: string
  tokens: number
  deferred: boolean
}

/** Local composition and the composition captured before the latest provider usage sample. */
export interface ContextBreakdownProjection {
  systemTokens: number
  /** Active tool schemas, retained for consumers of the aggregate. */
  toolsTokens: number
  messageTokens: number
  mcpToolsTokens: number
  builtinToolsTokens: number
  skillsTokens: number
  memoryTokens: number
  agentsTokens: number
  mcpInstructionsTokens: number
  deferredMcpTokens: number
  deferredBuiltinTokens: number
  items: {
    mcpTools: ContextBreakdownItem[]
    builtinTools: ContextBreakdownItem[]
    memory: ContextBreakdownItem[]
    agents: ContextBreakdownItem[]
    skills: ContextBreakdownItem[]
  }
  /** Local category weights at the provider's input sample, before its response joins the surface. */
  sampled?: {
    systemTokens: number
    messageTokens: number
    mcpToolsTokens: number
    builtinToolsTokens: number
    skillsTokens: number
    memoryTokens: number
    agentsTokens: number
    mcpInstructionsTokens: number
  } | undefined
}

declare module '@panedesk/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Provider-reported usage accumulated across the complete durable log. */
    tokenUsage: TokenUsageProjection
    /** Newest request pressure paired with the newest known route capacity. */
    contextPressure: ContextPressureProjection
    /** Provider-sampled category weights and current local contributions. */
    contextBreakdown: ContextBreakdownProjection
    /** Configured automatic-compaction trigger reservation; absent without a contributing backend. */
    contextCompaction: { reserveTokens: number }
  }
}
