/** Exact decimal reference pricing; no provider rates are embedded in this module. */
import type {
  LedgerPriceEntry, LedgerPriceTable, LedgerPriceUsageRequest, LedgerPriceUsageResult,
  LedgerTokenColumns, LedgerUnitPrices,
} from './types.ts'

const decimalPattern = /^(0|[1-9]\d*)(?:\.\d+)?$/

type Decimal = { units: bigint; scale: number }

function decimal(value: string): Decimal {
  if (!decimalPattern.test(value)) throw new Error('Invalid nonnegative decimal price')
  const [whole = '0', fraction = ''] = value.split('.')
  return { units: BigInt(whole + fraction), scale: fraction.length }
}

function sumDecimal(values: readonly Decimal[]): Decimal {
  const scale = Math.max(0, ...values.map(value => value.scale))
  return { units: values.reduce((sum, value) => sum + value.units * 10n ** BigInt(scale - value.scale), 0n), scale }
}

function format(value: Decimal): string {
  if (!value.scale) return value.units.toString()
  const digits = value.units.toString().padStart(value.scale + 1, '0')
  return `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(/\.?0+$/, '') || '0'
}

function pricesAt(entry: LedgerPriceEntry, input: number, startedAt: number): LedgerUnitPrices {
  const date = new Date(startedAt)
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600
  const time = entry.timeRules?.find(rule => rule.weekdays.some(day => day === date.getUTCDay())
    && hour >= rule.fromHour && hour < rule.toHour)
  // Context replacement is the final whole-call rule, never a marginal surcharge.
  return entry.contextRule && input > entry.contextRule.thresholdTokens ? entry.contextRule.prices : time?.prices ?? entry.prices
}

/** Project five disjoint token columns; untiered writes remain only in their total column.
 * @param request - Authoritative usage and provider tier evidence.
 * @returns Missing counters remain absent rather than being invented as zero.
 */
export function tokenColumns(request: LedgerPriceUsageRequest): LedgerTokenColumns {
  const usage = request.usage
  const total = usage?.cacheWriteTokens
  const long = usage?.cacheWriteLongTokens
  return {
    ...usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens },
    ...usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens },
    ...usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens },
    ...total === undefined ? {} : { cacheWriteTokens: total },
    cacheWriteTiering: request.tiering,
    ...(request.tiering.kind === 'tiered' && total !== undefined && long !== undefined
      ? { cacheWriteShortTokens: total - long, cacheWriteLongTokens: long } : {}),
  }
}

function terms(request: LedgerPriceUsageRequest): { state: LedgerPriceUsageResult['state']; values: [string, string][] } {
  const usage = request.usage
  if (!usage || request.usageState === 'missing') return { state: 'missing-usage', values: [] }
  if (request.usageState !== 'complete') return { state: 'partial-usage', values: [] }
  const columns = tokenColumns(request)
  const { inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write } = columns
  if (input === undefined || output === undefined || read === undefined || write === undefined
    || [input, output, read, write].some(value => !Number.isSafeInteger(value) || value < 0)) {
    return { state: 'partial-usage', values: [] }
  }
  if (!request.entry) return { state: 'missing-price', values: [] }
  const prices = pricesAt(request.entry, input + read + write, request.startedAt)
  const values: [string, string][] = [[String(input), prices.input], [String(read), prices.cacheRead], [String(output), prices.output]]
  if (request.tiering.kind === 'tiered') {
    const short = columns.cacheWriteShortTokens
    const long = columns.cacheWriteLongTokens
    if (short === undefined || long === undefined || !Number.isSafeInteger(long) || short < 0 || long < 0) return { state: 'partial-usage', values: [] }
    for (const [count, tier] of [[short, request.tiering.short], [long, request.tiering.long]] as const) {
      const price = prices.cacheWrite[tier]
      if (price === undefined && count > 0) return { state: 'missing-price', values: [] }
      values.push([String(count), price ?? '0'])
    }
  } else if (write > 0) {
    const price = request.tiering.kind === 'untiered' ? prices.cacheWrite.untiered : undefined
    if (price === undefined) return { state: 'missing-price', values: [] }
    values.push([String(write), price])
  }
  if (prices.cacheStoragePerMillionTokenHour !== undefined) {
    if (request.cacheStorageTokenHours === undefined) return { state: 'partial-usage', values: [] }
    values.push([request.cacheStorageTokenHours, prices.cacheStoragePerMillionTokenHour])
  }
  return { state: 'priced', values }
}

/** Compute USD using arbitrary-precision decimal integers and a million-token denominator.
 * @param request - Frozen reference entry and complete provider evidence.
 * @returns Exact decimal amount, or a named coverage gap without an amount.
 */
export function priceUsage(request: LedgerPriceUsageRequest): LedgerPriceUsageResult {
  const { state, values } = terms(request)
  const result: LedgerPriceUsageResult = {
    state, ...request.entry === undefined ? {} : { priceVersion: request.entry.version }, reference: true,
  }
  if (state !== 'priced') return result
  const sum = sumDecimal(values.map(([count, price]) => {
    const a = decimal(count)
    const b = decimal(price)
    return { units: a.units * b.units, scale: a.scale + b.scale }
  }))
  return { ...result, costUsd: format({ units: sum.units, scale: sum.scale + 6 }) }
}

/** Independently recompute arithmetic with floating-point products for external verification.
 * @param request - The same frozen price selection and usage evidence.
 * @returns Numeric USD, or undefined when pricing evidence is incomplete.
 */
export function recomputeUsage(request: LedgerPriceUsageRequest): number | undefined {
  const selected = terms(request)
  if (selected.state !== 'priced') return undefined
  return selected.values.reduce((sum, [count, price]) => sum + Number(count) * Number(price) / 1_000_000, 0)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid price object')
  return value as Record<string, unknown>
}

function metadata(value: Record<string, unknown>): void {
  if (typeof value.version !== 'string' || !value.version || value.reference !== true
    || typeof value.retrievedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.retrievedOn)
    || !Number.isFinite(Date.parse(value.retrievedOn))
    || new Date(value.retrievedOn).toISOString().slice(0, 10) !== value.retrievedOn
    || !Array.isArray(value.sourceUrls) || !value.sourceUrls.length) throw new Error('Missing reference price metadata')
  for (const source of value.sourceUrls) {
    if (typeof source !== 'string') throw new Error('Invalid reference source URL')
    const url = new URL(source)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid reference source URL')
  }
}

function validatePrices(value: unknown): void {
  const prices = object(value)
  for (const key of ['input', 'output', 'cacheRead']) {
    if (typeof prices[key] !== 'string') throw new Error('Missing token price')
    decimal(prices[key])
  }
  for (const price of Object.values(object(prices.cacheWrite))) {
    if (typeof price !== 'string') throw new Error('Invalid write price')
    decimal(price)
  }
  if (prices.cacheStoragePerMillionTokenHour !== undefined) {
    if (typeof prices.cacheStoragePerMillionTokenHour !== 'string') throw new Error('Invalid storage price')
    decimal(prices.cacheStoragePerMillionTokenHour)
  }
}

/** Parse and validate a versioned price table at the file/configuration boundary.
 * @param text - Serialized table, including explicit reference metadata on every entry.
 * @returns Validated table; malformed prices and ambiguous time windows reject.
 */
export function loadPriceTable(text: string): LedgerPriceTable {
  const value: unknown = JSON.parse(text)
  assertPriceTable(value)
  return value
}

function assertPriceTable(value: unknown): asserts value is LedgerPriceTable {
  const table = object(value)
  metadata(table)
  if (!Array.isArray(table.entries)) throw new Error('Missing price entries')
  const keys = new Set<string>()
  for (const raw of table.entries) {
    const entry = object(raw)
    metadata(entry)
    if (entry.version !== table.version || entry.currency !== 'USD' || typeof entry.modelFamily !== 'string'
      || !entry.modelFamily || typeof entry.modelKey !== 'string' || !entry.modelKey
      || typeof entry.holidaysUnmodeled !== 'boolean') throw new Error('Invalid price entry')
    const key = JSON.stringify([entry.modelFamily, entry.modelKey])
    if (keys.has(key)) throw new Error('Duplicate price key')
    keys.add(key)
    validatePrices(entry.prices)
    if (entry.contextRule !== undefined) {
      const rule = object(entry.contextRule)
      if (!Number.isSafeInteger(rule.thresholdTokens) || Number(rule.thresholdTokens) < 0
        || rule.counting !== 'all-input-including-cache-read-write') throw new Error('Invalid context price rule')
      validatePrices(rule.prices)
    }
    if (entry.timeRules !== undefined) {
      if (!Array.isArray(entry.timeRules)) throw new Error('Invalid time rules')
      const windows: { day: number; from: number; to: number }[] = []
      for (const rawRule of entry.timeRules) {
        const rule = object(rawRule)
        if (!Array.isArray(rule.weekdays) || !rule.weekdays.length || typeof rule.fromHour !== 'number'
          || typeof rule.toHour !== 'number' || !Number.isFinite(rule.fromHour) || !Number.isFinite(rule.toHour)
          || rule.fromHour < 0 || rule.toHour > 24 || rule.fromHour >= rule.toHour) throw new Error('Invalid UTC price window')
        const from = rule.fromHour
        const to = rule.toHour
        const weekdays: readonly unknown[] = rule.weekdays
        for (const day of weekdays) {
          if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6
            || windows.some(window => window.day === day && window.from < to && window.to > from)) {
            throw new Error('Ambiguous UTC price window')
          }
          windows.push({ day, from, to })
        }
        validatePrices(rule.prices)
      }
    }
  }
}
