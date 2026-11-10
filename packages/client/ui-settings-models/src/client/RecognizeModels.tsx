/**
 * The provider card's recognize-and-try controls. Recognition asks the route's
 * listing and checks the newest model per family; a model id typed by hand is
 * probed with one output token.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { LlmDiscoveredModel } from '@panedesk/dsh-api-remotes/client'
import { defaultRecognizedSelection } from './recognize.ts'
import type { RecognizeOrderBasis } from './recognize.ts'
import type { ModelProbeOutcome, ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import { ProbeAttemptFacts, ProtocolProbe } from './ProtocolProbe.tsx'
import type { ProbeTarget } from './ModelListEditor.tsx'
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
  /** Whether recognition must wait for a configured API key. */
  readonly keyRequired?: boolean | undefined
  /**
   * How many models this card's provider already has configured. The guide under
   * the recognize button shows only while that count is zero; callers that do
   * not know the count omit it and the guide stays hidden.
   */
  readonly modelCount?: number | undefined
  /** Configured entries, including ids absent from discovery. */
  readonly configuredModels?: readonly LlmDiscoveredModel[] | undefined
  /** Persist the selected catalog through the existing settings owner. */
  readonly onAdopt?: ((models: readonly LlmDiscoveredModel[]) => Promise<string | undefined>) | undefined
  /**
   * Settings revision a saved protocol writes against, and the refresh a
   * successful save runs. Both come from the provider row: the list offers the
   * same protocol action as an editable model row.
   */
  readonly revision?: number | undefined
  /** Refresh the provider directory after a protocol save commits. */
  readonly onProtocolSaved?: (() => void) | undefined
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
  const [saved, setSaved] = useState<number | undefined>(undefined)
  const [manualId, setManualId] = useState('')
  const [probe, setProbe] = useState<ModelProbeOutcome | undefined>(undefined)

  const recognize = async (): Promise<void> => {
    if (props.keyRequired === true) return
    setBusy(true)
    setFailure(undefined)
    setSaved(undefined)
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
      if (answer.models.length === 0 && (props.configuredModels?.length ?? 0) === 0) {
        setFailure(t('recognizeEmpty'))
        setRecognized(undefined)
        return
      }
      const selection = defaultRecognizedSelection(answer.models, props.configuredModels)
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
      setProbe({ ok: false, reason: 'other', message: t('tryNeedsId'), body: t('tryNeedsId') })
      return
    }
    setBusy(true)
    setProbe(undefined)
    try {
      setProbe(await operations.probeModel(provider, model))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      setProbe({ ok: false, reason: 'other', message, body: message })
    } finally {
      setBusy(false)
    }
  }

  const adopt = async (): Promise<void> => {
    if (recognized === undefined || props.onAdopt === undefined) return
    setBusy(true)
    setFailure(undefined)
    setSaved(undefined)
    try {
      const chosen = recognized.models.filter(model => recognized.checked.has(model.id))
      const refusal = await props.onAdopt(chosen)
      if (refusal !== undefined) setFailure(refusal)
      else setSaved(chosen.length)
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  // The route's stored endpoint is what the protocol matrix asks. Naming the
  // route lets an adapter that already describes it answer from its registry.
  const probeTarget: ProbeTarget = {
    settingsNs,
    provider,
    ...endpoint?.baseURL === undefined || endpoint.baseURL.length === 0 ? {} : { baseURL: endpoint.baseURL },
    ...endpoint?.api === undefined ? {} : { api: endpoint.api },
  }
  const configuredIds = new Set(props.configuredModels?.map(model => model.id))
  const additions = [...recognized?.checked ?? []].filter(id => !configuredIds.has(id)).length
  const removals = [...configuredIds].filter(id => !recognized?.checked.has(id)).length

  return (
    <div className={styles['recognize']}>
      <button type="button" className={styles['secondaryButton']} disabled={disabled || busy || props.keyRequired === true} onClick={() => { void recognize() }}>
        {busy ? t('recognizing') : t('recognize')}
      </button>
      {props.keyRequired === true ? <p className={styles['modelCatalogMeta']}>{t('recognizeNeedsKey')}</p> : null}
      {recognized === undefined && props.modelCount === 0 && props.keyRequired !== true ? <p className={styles['modelCatalogMeta']}>{t('recognizeGuide')}</p> : null}
      {failure === undefined ? null : <p role="alert">{t('recognizeFailed')}: {failure}</p>}
      {recognized === undefined
        ? null
        : (
          <div>
            <p>{t('recognizeLead').replace('{count}', String(recognized.checked.size))}</p>
            <p className={styles['modelCatalogMeta']}>
              {t(recognized.orderBasis === 'version'
                ? 'recognizeOrderVersion'
                : recognized.orderBasis === 'createdAt' ? 'recognizeOrderCreated' : 'recognizeOrderServer')}
            </p>
            <ul className={styles['candidateList']}>
              {recognized.models.map(model => (
                <li key={model.id} className={styles['candidate']}>
                  <label className={styles['candidateLabel']}>
                    <input
                      type="checkbox"
                      checked={recognized.checked.has(model.id)}
                      disabled={disabled || busy}
                      onChange={() => { toggle(model.id) }}
                    />
                    <span className={styles['candidateId']}>{model.name ?? model.id}</span>
                    {configuredIds.has(model.id) ? <span>{t('recognizedAdded')}</span> : null}
                    <ProtocolProbe
                      target={probeTarget}
                      model={model.id}
                      imageDeclared={model.inputModalities?.includes('image') === true}
                      operations={operations}
                      t={t}
                      disabled={disabled || busy}
                      revision={props.revision}
                      onSaved={() => { props.onProtocolSaved?.() }}
                    />
                  </label>
                </li>
              ))}
            </ul>
            <p role="status">{t('recognizedChanges').replace('{add}', String(additions)).replace('{remove}', String(removals))}</p>
            {props.onAdopt === undefined ? null : <button type="button" disabled={disabled || busy} onClick={() => { void adopt() }}>{t('fetchAdopt')}</button>}
          </div>
        )}
      {saved === undefined ? null : <p role="status">{t('recognizedSaved').replace('{count}', String(saved))}</p>}
      <label>
        {t('tryModelId')}
        <input value={manualId} disabled={disabled || busy} onChange={(event) => { setManualId(event.target.value) }} />
      </label>
      <button type="button" className={styles['secondaryButton']} aria-busy={busy} disabled={disabled || busy} onClick={() => { void tryOnce() }}>
        {busy ? t('trying') : t('tryOnce')}
      </button>
      {probe?.ok === true ? <p role="status">{t('trySucceeded')}</p> : null}
      <ProbeAttemptFacts probe={probe} t={t} />
    </div>
  )
}
