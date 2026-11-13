/** Right-button hold gestures owned by one open model list. */
import { useEffect, useRef, type PointerEvent } from 'react'
import { saveModelOrder } from './provider-order.ts'
import css from './ModelSelect.module.css'

/**
 * Keep pointer tracking outside the rows so a right drag never selects a model.
 * @param groups - Complete ordered catalog, including models hidden by search.
 * @param changed - Refresh the picker after a completed local reorder.
 * @param open - Whether the owning menu is mounted.
 * @returns A delegated pointer handler for the model-list viewport.
 */
export function useModelReorder(
  groups: readonly { id: string; models: readonly { id: string }[] }[],
  changed: () => void,
  open: boolean,
): (event: PointerEvent<HTMLDivElement>) => void {
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => { cleanup.current?.() }, [open])

  return (event) => {
    if (event.button !== 2 || !(event.target instanceof Element)) return
    const viewport = event.currentTarget
    const row = event.target.closest<HTMLElement>('[data-order-model], [data-menu-group-heading]')
    if (row === null || row.matches(':disabled')) return
    event.preventDefault()
    cleanup.current?.()
    const section = row.closest<HTMLElement>('[data-menu-group]')!
    const groupId = section.querySelector<HTMLElement>('[data-order-group]')!.dataset.orderGroup!
    const modelId = row.dataset.orderModel
    const source = modelId === undefined ? section : row
    const sourceId = modelId ?? groupId
    let dragging = false
    let target: HTMLElement | null = null
    let targetId = sourceId
    let after = false
    const clearTarget = (): void => {
      target?.classList.remove(css.dropBefore!, css.dropAfter!)
      target = null
    }
    const stop = (): void => {
      window.clearTimeout(timer)
      source.classList.remove(css.dragging!)
      clearTarget()
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stop)
      cleanup.current = null
    }
    const move = (next: globalThis.PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return
      if (!dragging) {
        if (Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) > 5) stop()
        return
      }
      next.preventDefault()
      clearTarget()
      const hit = document.elementFromPoint(next.clientX, next.clientY)
      const candidate = hit?.closest<HTMLElement>(modelId === undefined ? '[data-menu-group]' : '[data-order-model]')
      if (candidate === undefined || candidate === null || !viewport.contains(candidate) || candidate === source) return
      if (modelId !== undefined && candidate.closest('[data-menu-group]') !== section) return
      target = candidate
      targetId = modelId === undefined
        ? candidate.querySelector<HTMLElement>('[data-order-group]')!.dataset.orderGroup!
        : candidate.dataset.orderModel!
      const rect = candidate.getBoundingClientRect()
      after = next.clientY > rect.top + rect.height / 2
      target.classList.add(after ? css.dropAfter! : css.dropBefore!)
    }
    const finish = (next: globalThis.PointerEvent): void => {
      if (next.pointerId !== event.pointerId || next.button !== 2) return
      const dropped = dragging && target !== null
      stop()
      if (!dropped) return
      const ids = (modelId === undefined ? groups : groups.find(group => group.id === groupId)!.models)
        .map(item => item.id).filter(id => id !== sourceId)
      ids.splice(ids.indexOf(targetId) + (after ? 1 : 0), 0, sourceId)
      saveModelOrder(ids, modelId === undefined ? undefined : groupId)
      changed()
    }
    const timer = window.setTimeout(() => {
      dragging = true
      source.classList.add(css.dragging!)
    }, 300)
    cleanup.current = stop
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
  }
}
