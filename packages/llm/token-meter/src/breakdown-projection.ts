/** Display-only context composition, replayed from retained messages and tool schemas. */

import { z } from 'zod'
import { lastAssistantStreamChunk } from '@panedesk/dsh-llm'
import type { Message } from '@panedesk/dsh-llm'
import { canonicalHeader, deriveEventMessage, isSurfaceEvent, SessionSeq } from '@panedesk/dsh-session'
import type { SessionEvent, SurfaceEvent } from '@panedesk/dsh-session'
import type { ProjectionDefinition } from '@panedesk/dsh-session-projection'
import type {} from '@panedesk/dsh-compaction'
import type {} from './projection.ts'
import { estimateMessage, estimateText } from './estimate.ts'

const tokenCount = z.number().int().nonnegative()
const sessionSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq)
const itemSchema = z.object({ name: z.string(), tokens: tokenCount, deferred: z.boolean() }).strict()
const categoriesSchema = z.object({
  systemTokens: tokenCount,
  messageTokens: tokenCount,
  mcpToolsTokens: tokenCount,
  builtinToolsTokens: tokenCount,
  skillsTokens: tokenCount,
  memoryTokens: tokenCount,
  agentsTokens: tokenCount,
  mcpInstructionsTokens: tokenCount,
}).strict()
const itemsSchema = z.object({
  mcpTools: z.array(itemSchema), builtinTools: z.array(itemSchema),
  memory: z.array(itemSchema), agents: z.array(itemSchema), skills: z.array(itemSchema),
}).strict()
const breakdownSchema = categoriesSchema.extend({
  toolsTokens: tokenCount,
  deferredMcpTokens: tokenCount,
  deferredBuiltinTokens: tokenCount,
  items: itemsSchema,
  sampled: categoriesSchema.optional(),
}).strict()
const contributionSchema = z.object({
  seq: sessionSeq,
  tokens: tokenCount,
  categories: categoriesSchema,
  items: itemsSchema,
}).strict()
const claimSchema = z.object({
  start: sessionSeq, end: sessionSeq, tokens: tokenCount, shadowedSeqs: z.array(sessionSeq),
}).strict()
const stateSchema = z.object({
  systems: z.array(contributionSchema),
  contributions: z.array(contributionSchema),
  surfaceTokens: tokenCount,
  claim: claimSchema.optional(),
  tools: breakdownSchema,
  breakdown: breakdownSchema,
}).strict()
type State = z.infer<typeof stateSchema>
type Categories = z.infer<typeof categoriesSchema>
type Items = z.infer<typeof itemsSchema>
type Contribution = z.infer<typeof contributionSchema>

const emptyCategories = (): Categories => ({
  systemTokens: 0, messageTokens: 0, mcpToolsTokens: 0, builtinToolsTokens: 0,
  skillsTokens: 0, memoryTokens: 0, agentsTokens: 0, mcpInstructionsTokens: 0,
})
const emptyItems = (): Items => ({ mcpTools: [], builtinTools: [], memory: [], agents: [], skills: [] })
const emptyBreakdown = (): z.infer<typeof breakdownSchema> => ({
  ...emptyCategories(), toolsTokens: 0, deferredMcpTokens: 0, deferredBuiltinTokens: 0, items: emptyItems(),
})

/** Assign an entire framed contribution without also charging it to messages. */
function splitItems(text: string, expression: RegExp, tokens: number): Items['memory'] {
  const matches = [...text.matchAll(expression)]
  const weights = matches.map(match => estimateText(match[0]))
  const total = weights.reduce((sum, value) => sum + value, 0)
  let assigned = 0
  let cumulative = 0
  return matches.map((match, index) => {
    cumulative += weights[index]!
    const end = total === 0 ? 0 : Math.round(tokens * cumulative / total)
    const value = { name: match[1]!.trim(), tokens: end - assigned, deferred: false }
    assigned = end
    return value
  })
}

function classify(message: Message, seq: SessionSeq): Contribution {
  const tokens = estimateMessage(message)
  const categories = emptyCategories()
  const items = emptyItems()
  const source: string = message.source.kind
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  if (message.role === 'system') {
    const instructions = [...text.matchAll(/^### MCP server: [^\n]+\n[\s\S]*?(?=^#{1,3} |$(?![\s\S]))/gm)]
    categories.mcpInstructionsTokens = Math.min(tokens, instructions.reduce((sum, match) => sum + estimateText(match[0]), 0))
    categories.systemTokens = tokens - categories.mcpInstructionsTokens
  } else {
    if (source === 'agent-instructions' || source === 'runtime-context') {
      const expression = /^(?:(?:Additional |Updated )?[Ii]nstructions from(?: memory)?|Instructions removed): ([^\n]+)\n[\s\S]*?(?=^(?:(?:Additional |Updated )?[Ii]nstructions from(?: memory)?|Instructions removed): |<\/system-reminder>|$(?![\s\S]))/gm
      const fragments = [...text.matchAll(expression)]
      const memoryTokens = source === 'agent-instructions' ? tokens
        : Math.min(tokens, fragments.reduce((sum, match) => sum + estimateText(match[0]), 0))
      categories.memoryTokens = memoryTokens
      items.memory = splitItems(text, expression, memoryTokens)
    }
    if ((source === 'skill-catalog' || source === 'runtime-context') && text.includes('<available_skills>')) {
      const catalog = text.split('<available_skills>')[1]!.split('</available_skills>')[0]!
      categories.skillsTokens = source === 'skill-catalog' ? tokens
        : Math.min(tokens - categories.memoryTokens, estimateText(catalog))
      items.skills = splitItems(catalog, /^- `([^`]+)`: [^\n]*/gm, categories.skillsTokens)
    }
  }
  return { seq, tokens, categories, items }
}

function toolBreakdown(event: Extract<SessionEvent, { type: 'request/header' }>): State['tools'] {
  const result = emptyBreakdown()
  for (const tool of canonicalHeader(event.data.header).tools ?? []) {
    let tokens = estimateText(JSON.stringify(tool)) + 4
    const mcp = tool.name.startsWith('mcp__')
    const deferred = tool.deferLoading === true
    // Preset descriptions are embedded twice in the tool declaration, not sent as a separate prompt.
    if (!deferred && !mcp) {
      const catalogs = [...JSON.stringify(tool).matchAll(/"(?:[^"\\]|\\.)*"/g)]
        .map(match => JSON.parse(match[0]) as string)
        .filter(text => text.includes('Available presets: '))
        .map(text => text.slice(text.indexOf('Available presets: ')))
      const agentTokens = Math.min(tokens, catalogs.reduce((sum, text) => sum + estimateText(text), 0))
      result.agentsTokens += agentTokens
      if (catalogs.length > 0) {
        const catalog = catalogs[0]!.slice('Available presets: '.length)
        result.items.agents.push(...splitItems(catalog, /(?:^|; )([^:\n]+): [\s\S]*?(?=; [^:\n]+: |$(?![\s\S]))/g, agentTokens))
      }
      tokens -= agentTokens
    }
    const item = { name: tool.name, tokens, deferred }
    if (mcp) {
      result.items.mcpTools.push(item)
      if (deferred) result.deferredMcpTokens += tokens
      else result.mcpToolsTokens += tokens
    } else {
      result.items.builtinTools.push(item)
      if (deferred) result.deferredBuiltinTokens += tokens
      else result.builtinToolsTokens += tokens
    }
  }
  result.toolsTokens = result.mcpToolsTokens + result.builtinToolsTokens
  return result
}

function publish(state: State): State {
  const breakdown = { ...state.tools, items: structuredClone(state.tools.items), sampled: state.breakdown.sampled }
  const system = state.systems.findLast(node => node.tokens > 0)
  let attributed = 0
  for (const node of [...system === undefined ? [] : [system], ...state.contributions]) {
    for (const key of Object.keys(node.categories) as (keyof Categories)[]) {
      breakdown[key] += node.categories[key]
      attributed += node.categories[key]
    }
    for (const key of Object.keys(node.items) as (keyof Items)[]) breakdown.items[key].push(...node.items[key])
  }
  breakdown.messageTokens = Math.max(0, state.surfaceTokens - attributed)
  // Repeated instruction baselines retain their context cost but list each path only once.
  for (const key of Object.keys(breakdown.items) as (keyof Items)[]) {
    const merged = new Map<string, Items[typeof key][number]>()
    for (const item of breakdown.items[key]) {
      const previous = merged.get(item.name)
      merged.set(item.name, { ...item, tokens: item.tokens + (previous?.tokens ?? 0) })
    }
    breakdown.items[key] = [...merged.values()]
  }
  return { ...state, breakdown }
}

function place(state: State, event: SurfaceEvent, node: Contribution): State {
  const op = event.surfaceOp
  const system = event.type === 'system/message'
  const classified = Object.values(node.categories).some(tokens => tokens > 0)
  let systems = state.systems
  let contributions = state.contributions
  let surfaceTokens = state.surfaceTokens
  if (op === 'append') surfaceTokens += node.tokens
  else if (state.claim !== undefined) {
    if (state.claim.start !== op.startSeq || state.claim.end !== op.endSeq) {
      throw new Error(`context breakdown: replacement at ${event.seq} differs from its adjacent shadow price`)
    }
    const shadowed = new Set(state.claim.shadowedSeqs)
    systems = systems.filter(entry => !shadowed.has(entry.seq))
    contributions = contributions.filter(entry => !shadowed.has(entry.seq))
    surfaceTokens += node.tokens - state.claim.tokens
  } else {
    const replaced = [...systems, ...contributions].find(entry => entry.seq === op.startSeq && op.startSeq === op.endSeq)
    if (replaced === undefined) return state
    surfaceTokens += node.tokens - replaced.tokens
    systems = systems.map(entry => entry.seq === replaced.seq ? node : entry)
    if (system && state.systems.some(entry => entry.seq === replaced.seq)) {
      return publish({ ...state, systems, surfaceTokens: Math.max(0, surfaceTokens) })
    }
    systems = systems.filter(entry => entry.seq !== replaced.seq)
    contributions = contributions.filter(entry => entry.seq !== replaced.seq)
  }
  if (system) systems = [...systems, node]
  else if (classified) contributions = [...contributions, node]
  return publish({ ...state, systems, contributions, surfaceTokens: Math.max(0, surfaceTokens) })
}

declare module '@panedesk/dsh-session-projection/types' {
  interface SessionProjectionStateMap { contextBreakdown: State }
}

/** Display-only classification; provider sampling captures input weights before response text is appended. */
export const contextBreakdownProjectionDefinition = {
  key: 'contextBreakdown',
  stateVersion: 7,
  stateSchema,
  init: (): State => ({ systems: [], contributions: [], surfaceTokens: 0, tools: emptyBreakdown(), breakdown: emptyBreakdown() }),
  apply: (state, event) => {
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      return { ...state, claim: {
        start: SessionSeq(event.data.shadowedRange.start), end: SessionSeq(event.data.shadowedRange.end),
        tokens: event.data.shadowedTokenCount, shadowedSeqs: event.data.shadowedSeqs.map(SessionSeq),
      } }
    }
    let next = state
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const usage = event.type === 'assistant/message' && event.data.usage !== undefined
        ? event.data.usage : lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
      if (usage !== undefined) {
        const sampled = emptyCategories()
        for (const key of Object.keys(sampled) as (keyof Categories)[]) sampled[key] = state.breakdown[key]
        next = { ...state, breakdown: { ...state.breakdown, sampled } }
      }
    }
    if (event.type === 'request/header') next = publish({ ...next, tools: toolBreakdown(event) })
    if (isSurfaceEvent(event)) {
      const message = deriveEventMessage(event)
      next = place(next, event, message === null
        ? { seq: event.seq, tokens: 0, categories: emptyCategories(), items: emptyItems() }
        : classify(message, event.seq))
    }
    if (next.claim === undefined) return next
    const { claim: _expired, ...unclaimed } = next
    return unclaimed
  },
  wire: { viewSchema: breakdownSchema, view: state => state.breakdown },
} satisfies ProjectionDefinition<'contextBreakdown', State>
