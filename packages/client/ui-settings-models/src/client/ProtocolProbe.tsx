/** Independent compatibility results and explicit protocol save actions for one model. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProbeTarget } from './ModelListEditor.tsx'
import type { ModelProbeOutcome, ModelsOperations, ProtocolResults } from './operations.ts'
import type { ModelsKey } from './locales.ts'
import { protocolLabel } from './protocol-label.ts'
import styles from './ModelsSection.module.css'

/** Live endpoint facts and the owning card's save completion. */
export interface ProtocolProbeProps {
  target: ProbeTarget
  model: string
  imageDeclared: boolean
  operations: ModelsOperations
  t: (key: ModelsKey) => string
  disabled: boolean
  revision?: number | undefined
  onSaved: () => void
  onBusyChange?: ((busy: boolean) => void) | undefined
}

/** One failed check or connection attempt: category, HTTP status, and the leading response body. */
interface ProbeFailure {
  reason?: ProtocolResults[number]['text']['reason'] | undefined
  status?: number | undefined
  body?: string | undefined
}

/**
 * Render one failure as category, HTTP status, and a folded response body.
 * @param failure - facts the host returned for this check.
 * @param t - page copy.
 * @returns the three labeled facts.
 */
function ProbeFailureFacts(props: { failure: ProbeFailure; t: (key: ModelsKey) => string }): ReactNode {
  const { failure, t } = props
  const reason = failure.reason ?? 'other'
  const body = failure.body ?? ''
  return <div>
    <p>{t('protocolCategory')}: {t(PROBE_REASONS[reason])}</p>
    <p>{t('protocolHttpStatus')}: {failure.status === undefined ? t('protocolStatusMissing') : `HTTP ${String(failure.status)}`}</p>
    {body.length === 0
      ? <p>{t('protocolRawBody')}: {t('protocolBodyMissing')}</p>
      : <details>
        <summary>{t('protocolRawBody')}</summary>
        <pre>{body}</pre>
      </details>}
  </div>
}

const PROBE_REASONS = { protocol: 'protocolUnsupported', auth: 'protocolAuth', model: 'protocolModel', timeout: 'protocolTimeout', other: 'protocolOther' } as const

/**
 * Render a finished one-shot connection attempt with the same three facts.
 * @param props - the attempt outcome and page copy.
 * @returns the three facts, or null while the attempt is still running.
 */
export function ProbeAttemptFacts(props: { probe: ModelProbeOutcome | undefined; t: (key: ModelsKey) => string }): ReactNode {
  const { probe, t } = props
  if (probe === undefined || probe.ok) return null
  // A missing id is a prompt, not a failed attempt, so it carries no category.
  if (probe.reason === undefined && probe.status === undefined) return <p role="status">{probe.message}</p>
  return <ProbeFailureFacts failure={probe} t={t} />
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
  return <div className={styles['protocolProbe']}>
    <button type="button" className={styles['secondaryButton']} aria-busy={busy} disabled={props.disabled || busy || model.trim().length === 0} onClick={() => { void probe() }}>
      {t(busy ? 'protocolProbing' : 'protocolProbe')}
    </button>
    <span className={styles['advancedHint']}> {t('protocolCost')}</span>
    {results === undefined ? null : <>
      <table>
        <thead><tr><th>{t('customApi')}</th>{capabilities.map(key => <th key={key}>{t(labels[key])}</th>)}</tr></thead>
        <tbody>{results.map(result => {
          const passed = result.text.ok
          return <tr key={result.api}>
            <th><label><input type="radio" name={`protocol-${target.provider ?? 'draft'}-${model}`} checked={selected === result.api} disabled={!passed || busy || props.disabled} onChange={() => { setSelected(result.api) }} />{protocolLabel(t, result.api)}</label></th>
            {capabilities.map(key => {
              const check = result[key]
              return <td key={key}>{key === 'image' && !props.imageDeclared ? t('protocolImageUndeclared')
                : check.ok ? t('protocolPassed') : <ProbeFailureFacts failure={check} t={t} />}</td>
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
