/** Shared local ordering for the composer and command model pickers. */

const ORDER_KEY = 'panedesk.modelPicker.order'

interface PickerOrder {
  groups: string[]
  models: Record<string, string[]>
}

function readOrder(): PickerOrder {
  let saved: unknown
  try {
    saved = JSON.parse(localStorage.getItem(ORDER_KEY) ?? 'null')
  } catch (error) {
    // Unreadable or malformed preferences leave the catalog order intact.
    return { groups: [], models: {} }
  }
  if (saved !== null && typeof saved === 'object' && 'groups' in saved && 'models' in saved
    && Array.isArray(saved.groups) && saved.groups.every(id => typeof id === 'string')
    && saved.models !== null && typeof saved.models === 'object' && !Array.isArray(saved.models)
    && Object.values(saved.models).every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string'))) {
    return saved as PickerOrder
  }
  return { groups: [], models: {} }
}

function savedOrder<T extends { readonly id: string }>(items: readonly T[], ids: readonly string[]): T[] {
  const positions = new Map(ids.map((id, index) => [id, index]))
  return items.toSorted((left, right) =>
    (positions.get(left.id) ?? ids.length) - (positions.get(right.id) ?? ids.length))
}

/**
 * Apply saved group and model positions after the default provider ordering.
 * @param groups - Provider groups in catalog order.
 * @returns Copies with saved entries first and new entries in their original relative order.
 */
export function orderModelProviders<T extends { readonly id: string; readonly models: readonly { readonly id: string }[] }>(groups: readonly T[]): T[] {
  const order = readOrder()
  const defaults = groups.toSorted((left, right) =>
    (left.id === 'deepseek-account' ? 0 : left.id === 'deepseek-official' ? 1 : 2)
      - (right.id === 'deepseek-account' ? 0 : right.id === 'deepseek-official' ? 1 : 2))
  return savedOrder(defaults, order.groups).map(group => ({
    ...group, models: savedOrder(group.models, order.models[group.id] ?? []),
  }))
}

/**
 * Save one reordered list without replacing preferences for other providers.
 * @param ids - Complete displayed group or within-group model order.
 * @param group - Provider id for model ordering; omitted for group ordering.
 */
export function saveModelOrder(ids: string[], group?: string): void {
  const order = readOrder()
  if (group === undefined) order.groups = ids
  else order.models[group] = ids
  localStorage.setItem(ORDER_KEY, JSON.stringify(order))
}
