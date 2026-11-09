/** Shared settings introduction; all product copy belongs to the caller's locale. */
import { useState } from 'react'
import { Button } from './Button.tsx'
import { writeClipboard } from './clipboard.ts'

/** Localized three-line guidance and optional first-use instructions. */
export interface SettingsPageHeaderProps {
  what: string
  whether: string
  ai: string
  labels: { what: string; whether: string; ai: string; copy: string; copied: string; copyFailed: string; once: string }
  steps?: readonly [string, string, string]
}

/**
 * Render a consistent settings introduction and copyable agent request.
 * @param props - Localized guidance and three optional first-use steps.
 * @returns The page introduction, without changing any settings.
 */
export function SettingsPageHeader({ what, whether, ai, labels, steps }: SettingsPageHeaderProps) {
  const [copied, setCopied] = useState<boolean>()
  return <header>
    <p><strong>{labels.what}: </strong>{what}</p>
    <p><strong>{labels.whether}: </strong>{whether}</p>
    <p><strong>{labels.ai}: </strong>{ai} <Button size="sm" variant="outline" onClick={() => {
      void writeClipboard(ai).then(setCopied)
    }}>{labels.copy}</Button></p>
    {copied !== undefined && <p role="status">{copied ? labels.copied : labels.copyFailed}</p>}
    {steps && <div><h3>{labels.once}</h3><ol>{steps.map(step => <li key={step}>{step}</li>)}</ol></div>}
  </header>
}
