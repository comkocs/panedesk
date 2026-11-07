/**
 * The provider card's recognize-and-try controls. Recognition asks the route's
 * listing and checks the three newest models; a model id typed by hand is
 * probed with one output token.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { LlmDiscoveredModel } from '@panedesk/dsh-api-remotes/client'
import { defaultRecognizedSelection } from './recognize.ts'
import type { RecognizeOrderBasis } from './recognize.ts'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Copy keys this card renders. */
type Copy = (key: keyof typeof en) => string

/** What one card needs to recognize and probe. */
export interface RecognizeModelsProps {
  /** Settings namespace whose discovery answers. */
  readonly settingsNs: string
  /** Registered provider route to list and probe. */
  readonly provider: string
  /**
   * Endpoint and protocol the route already stores. A route the adapter ships
   * no catalog for can only be listed through its endpoint, so recognition
   * forwards both instead of asking with the route name alone.
   */
  readonly endpoint?: { readonly baseURL?: string; readonly api?: string } | undefined
  /** Host operations. */
  readonly operations: ModelsOperations
  /** Section copy. */
  readonly t: Copy
  /** Whether the page is writable. */
  readonly disabled: boolean
  /** Persist the selected catalog through the existing settings owner. */
  readonly onAdopt?: ((models: readonly LlmDiscoveredModel[]) => Promise<string | undefined>) | undefined
}

/** One recognition result the card can show. */
interface Recognized {
  readonly models: readonly LlmDiscoveredModel[]
  readonly checked: ReadonlySet<string>
  readonly orderBasis: RecognizeOrderBasis
}

/**
 * Render the recognize action, its checklist, and the one-shot probe.
 * @param props - the route and the host operations.
 * @returns the card controls.
 */
export function RecognizeModels(props: RecognizeModelsProps): ReactNode {
  const { settingsNs, provider, endpoint, operations, t, disabled } = props
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [recognized, setRecognized] = useState<Recognized | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [manualId, setManualId] = useState('')
  const [probe, setProbe] = useState<{ readonly ok: boolean; readonly message: string } | undefined>(undefined)

  const recognize = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    setSaved(false)
    try {
      const answer = await operations.discoverModels(settingsNs, {
        provider,
        ...endpoint?.baseURL === undefined || endpoint.baseURL.length === 0 ? {} : { baseURL: endpoint.baseURL },
        ...endpoint?.api === undefined ? {} : { api: endpoint.api },
      })
      if (answer.kind === 'refused') {
        setFailure(answer.message)
        setRecognized(undefined)
        return
      }
      if (answer.models.length === 0) {
        setFailure(t('recognizeEmpty'))
        setRecognized(undefined)
        return
      }
      const selection = defaultRecognizedSelection(answer.models)
      setRecognized({ models: selection.models, checked: new Set(selection.checked), orderBasis: selection.orderBasis })
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
      setRecognized(undefined)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string): void => {
    setRecognized((current) => {
      if (current === undefined) return current
      const checked = new Set(current.checked)
      if (!checked.delete(id)) checked.add(id)
      return { ...current, checked }
    })
  }

  const tryOnce = async (): Promise<void> => {
    const model = manualId.trim()
    if (model.length === 0) {
      setProbe({ ok: false, message: t('tryNeedsId') })
      return
    }
    setBusy(true)
    setProbe(undefined)
    try {
      const answer = await operations.probeModel(provider, model)
      setProbe(answer.ok
        ? { ok: true, message: t('trySucceeded') }
        : { ok: false, message: answer.message ?? t('tryFailed') })
    } catch (error: unknown) {
      setProbe({ ok: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const adopt = async (): Promise<void> => {
    if (recognized === undefined || props.onAdopt === undefined) return
    setBusy(true)
    setFailure(undefined)
    setSaved(false)
    try {
      const refusal = await props.onAdopt(recognized.models.filter(model => recognized.checked.has(model.id)))
      if (refusal !== undefined) setFailure(refusal)
      else setSaved(true)
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles['recognize']}>
      <button type="button" className={styles['secondaryButton']} disabled={disabled || busy} onClick={() => { void recognize() }}>
        {busy ? t('recognizing') : t('recognize')}
      </button>
      {failure === undefined ? null : <p role="alert">{t('recognizeFailed')}: {failure}</p>}
      {recognized === undefined
        ? null
        : (
          <div>
            <p>
              {recognized.orderBasis === 'createdAt' ? t('recognizeOrderCreated') : t('recognizeOrderServer')}
            </p>
            <ul>
              {recognized.models.map(model => (
                <li key={model.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={recognized.checked.has(model.id)}
                      disabled={disabled || busy}
                      onChange={() => { toggle(model.id) }}
                    />
                    <span>{model.name ?? model.id}</span>
                  </label>
                </li>
              ))}
            </ul>
            {props.onAdopt === undefined ? null : <button type="button" disabled={disabled || busy || recognized.checked.size === 0} onClick={() => { void adopt() }}>{t('fetchAdopt')}</button>}
          </div>
        )}
      {saved ? <p role="status">{t('recognizedSaved')}</p> : null}
      <label>
        {t('tryModelId')}
        <input value={manualId} disabled={disabled || busy} onChange={(event) => { setManualId(event.target.value) }} />
      </label>
      <button type="button" className={styles['secondaryButton']} disabled={disabled || busy} onClick={() => { void tryOnce() }}>
        {t('tryOnce')}
      </button>
      {probe === undefined
        ? null
        : <p role="status">{probe.ok ? probe.message : `${t('tryFailed')}: ${probe.message}`}</p>}
    </div>
  )
}
