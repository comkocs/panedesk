/** Independent compatibility results and explicit protocol save actions for one model. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProbeTarget } from './ModelListEditor.tsx'
import type { ModelsOperations, ProtocolResults } from './operations.ts'
import type { ModelsKey } from './locales.ts'
import { protocolLabel } from './protocol-label.ts'
import styles from './ModelsSection.module.css'

/** Live endpoint facts and the owning card's save completion. */
export interface ProtocolProbeProps {
  target: ProbeTarget
  model: string
  operations: ModelsOperations
  t: (key: ModelsKey) => string
  disabled: boolean
  revision?: number | undefined
  onSaved: () => void
  onBusyChange?: ((busy: boolean) => void) | undefined
}

/**
 * Render the three-protocol, four-capability matrix without exposing credentials.
 * @param props - model, endpoint, and page-owned operations.
 * @returns the probe action and its latest results.
 */
export function ProtocolProbe(props: ProtocolProbeProps): ReactNode {
  const { target, model, operations, t } = props
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ProtocolResults>()
  const [selected, setSelected] = useState<ProtocolResults[number]['api']>()
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setResults(undefined)
    setSelected(undefined)
    setSaved(false)
    setFailed(false)
  }, [model, target.settingsNs, target.provider, target.baseURL, target.api, target.apiKey])
  useEffect(() => { props.onBusyChange?.(busy) }, [busy, props.onBusyChange])
  const capabilities = ['text', 'stream', 'tool', 'image'] as const
  const labels = { text: 'modelInputText', stream: 'protocolStream', tool: 'protocolTool', image: 'modelInputImage' } as const
  const reasons = { protocol: 'protocolUnsupported', auth: 'protocolAuth', model: 'protocolModel', timeout: 'protocolTimeout', other: 'protocolOther' } as const
  const probe = async (): Promise<void> => {
    setBusy(true)
    setFailed(false)
    setSaved(false)
    setResults(undefined)
    setSelected(undefined)
    try {
      const response = await operations.probeModelProtocols(target.settingsNs, target, model)
      setResults(response)
      setFailed(response === undefined)
    } finally { setBusy(false) }
  }
  const save = async (separate: boolean): Promise<void> => {
    if (selected === undefined) return
    setBusy(true)
    setFailed(false)
    try {
      const ok = await operations.saveModelProtocol(target.settingsNs, target, model, selected, separate, props.revision)
      setFailed(!ok)
      setSaved(ok)
      if (ok) props.onSaved()
    } finally { setBusy(false) }
  }
  return <div>
    <button type="button" className={styles['linkButton']} disabled={props.disabled || busy || model.trim().length === 0} onClick={() => { void probe() }}>
      {t(busy ? 'protocolProbing' : 'protocolProbe')}
    </button>
    <span className={styles['advancedHint']}> {t('protocolCost')}</span>
    {results === undefined ? null : <>
      <table>
        <thead><tr><th>{t('customApi')}</th>{capabilities.map(key => <th key={key}>{t(labels[key])}</th>)}</tr></thead>
        <tbody>{results.map(result => {
          const passed = capabilities.every(key => result[key].ok)
          return <tr key={result.api}>
            <th><label><input type="radio" name={`protocol-${target.provider ?? 'draft'}-${model}`} checked={selected === result.api} disabled={!passed || busy || props.disabled} onChange={() => { setSelected(result.api) }} />{protocolLabel(t, result.api)}</label></th>
            {capabilities.map(key => {
              const check = result[key]
              return <td key={key}>{check.ok ? t('protocolPassed') : `${t(reasons[check.reason ?? 'other'])}${check.status === undefined ? '' : ` (HTTP ${String(check.status)})`}`}</td>
            })}
          </tr>
        })}</tbody>
      </table>
      {selected === undefined || selected === target.api ? null : <div>
        <button type="button" className={styles['linkButton']} disabled={busy || props.disabled || target.settingsNs !== 'llm-pi-ai' || target.provider === undefined} onClick={() => { void save(false) }}>{t('protocolChange')}</button>
        <button type="button" className={styles['linkButton']} disabled={busy || props.disabled} onClick={() => { void save(true) }}>{t('protocolSeparate')}</button>
        {target.settingsNs === 'llm-pi-ai' ? null : <p className={styles['advancedHint']}>{t('protocolFixed')}</p>}
      </div>}
    </>}
    {failed ? <p role="alert" className={styles['error']}>{t('protocolFailed')}</p> : null}
    {saved ? <p role="status" className={styles['savedNotice']}>{t('protocolSaved')}</p> : null}
  </div>
}
