/** Preset-local choices use the shared menu and content-sized button. */
import { useState } from 'react'
import { Button, Menu } from '@panedesk/dsh-client-ui-primitives'

/** One labeled selector, including configured values not currently in the catalog.
 * @param props - localized choices, current value, and selection callback.
 * @returns A content-sized menu button.
 */
export function PresetSelect(props: { label: string; value: string; options: { id: string; label: string }[]; disabled: boolean; onSelect: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  return <div>
    <Menu open={open} onClose={() => setOpen(false)} items={props.options} selectedId={props.value} portal autoFocus
      anchor={<Button variant="outline" disabled={props.disabled} aria-label={props.label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(!open)}>{props.options.find(option => option.id === props.value)?.label ?? props.value}</Button>}
      onSelect={value => { props.onSelect(value); setOpen(false) }} />
  </div>
}
