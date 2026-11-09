/**
 * The model list of one pi-ai provider profile, plus the action that asks the
 * provider what it serves.
 *
 * The list is the profile's `models` array as the card holds it: an empty list
 * means "serve this route's built-in catalog", and any entry replaces that
 * catalog, so a row is only ever added deliberately. Fetching asks the endpoint
 * **the form currently shows** — including a key typed but not yet saved — so
 * adding a provider is one pass instead of save-then-return; the reply is
 * candidates the user picks from, never configuration written behind them.
 *
 * A provider that cannot be interrogated (an unreachable endpoint, a protocol
 * with no readable listing) is not a dead end: the failure is shown next to the
 * rows the user can still fill in by hand.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { LlmDiscoveredModel } from '@panedesk/dsh-api-remotes/client'
import { presetContextWindow } from '@panedesk/dsh-llm-pi-ai/src/context-presets.ts'
import { inferReasoningEfforts } from '@panedesk/dsh-llm-pi-ai/src/reasoning.ts'
import { Button, IconPlusOutlineRegular, Modal } from '@panedesk/dsh-client-ui-primitives'
import { contextSourceKey, formatCapacity, parseCapacity } from './DeepSeekModelsEditor.tsx'
import { defaultRecognizedSelection } from './recognize.ts'
import type { ModelsOperations } from './operations.ts'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { en } from './locales.ts'
import { ModelRow } from './ModelRow.tsx'
import styles from './ModelsSection.module.css'

/**
 * One configured model row. Fields this card does not edit must survive an
 * edit rather than being dropped by a rebuild.
 */
export type ModelDraft = DeepSeekModelDraft

/** A row's text field, or the empty string when unset or not a string. */
function textOf(model: ModelDraft, key: string): string {
  const value = model[key]
  return typeof value === 'string' ? value : ''
}

/** A row's numeric field, or `undefined` when unset or not a number. */
function numberOf(model: ModelDraft, key: string): number | undefined {
  const value = model[key]
  return typeof value === 'number' ? value : undefined
}

/** What an interrogation needs, taken from the live form. */
export interface ProbeTarget {
  /** Settings namespace whose adapter family answers. */
  settingsNs: string
  /**
   * Route being edited, when the card edits one. An adapter that already
   * describes it answers from its own registry, so such a card can ask without
   * an endpoint at all.
   */
  provider?: string
  /** Endpoint as the form currently shows it. */
  baseURL?: string
  /** Wire protocol the form names, when it names one. */
  api?: string
  /** Key typed into the form and not yet stored, when there is one. */
  apiKey?: string
}

/** Props of {@link ModelListEditor}. */
export interface ModelListEditorProps {
  /** The rows as currently drafted. */
  models: readonly ModelDraft[]
  /** Per-row compatibility action supplied by the owning provider card. */
  renderProtocolProbe?: (model: ModelDraft) => ReactNode
  /** Commit a recognized selection immediately on an existing provider. */
  onSaveSelection?: (models: ModelDraft[]) => Promise<string | undefined>
  /** Installed provider whose catalog supplies defaults without endpoint I/O. */
  catalogProvider?: string | undefined
  /**
   * Reasoning levels a hand-declared route's rows may declare in
   * `reasoningEfforts`, in escalation order; absent or empty shows no
   * reasoning control, leaving a catalog model's levels to the catalog.
   */
  reasoningLevels?: readonly string[] | undefined
  /** Route-level effort-parameter support, when explicitly configured. */
  reasoningCompat?: unknown
  /** Route input types for models without an explicit declaration. */
  defaultInput?: readonly string[] | undefined
  /** Whether the user layer currently owns the whole array; absent on a create. */
  overridden?: boolean
  /** Replace the drafted rows. */
  onChange: (models: ModelDraft[]) => void
  /** Remove the user-owned array and return to inheritance; absent on a create. */
  onReset?: () => void
  /** Endpoint facts for the fetch action. */
  probe: ProbeTarget
  /**
   * Fetch once, without a click, whenever this is set and the endpoint can be
   * asked. A later change of the endpoint or the key asks again.
   */
  autoDiscover?: boolean
  /** Called with the row a field edit just changed, so the owner can tell a typed row from an untouched one. */
  onRowEdited?: (index: number) => void
  /** Called with the row just removed, so the owner can drop its bookkeeping. */
  onRowRemoved?: (index: number) => void
  /**
   * Copy key naming why the fetch action is unavailable, or `undefined` when
   * it is. The card owns this because the key it would send is judged there:
   * asking with a key the form has already refused spends a round trip to be
   * told what the field already says.
   */
  probeBlocked?: keyof typeof en | undefined
  /** The Host operations whose interrogation answers the fetch action. */
  operations: ModelsOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every control (read-only deployment or a pending write). */
  disabled: boolean
  /**
   * Called once per change with whether an endpoint interrogation is in
   * flight. The owning card folds it into its own busy state so the surface
   * around the card — a mode switch, say — can refuse to move while the
   * answer, and the picker it opens, is still bound for this list.
   */
  onBusyChange: (busy: boolean) => void
}

/** The two token counts edited as K/M-suffixed text behind a row's disclosure. */
type CapacityField = 'contextWindow' | 'maxTokens'

/**
 * What an empty capacity field is worth, shown as its placeholder so a row left
 * blank does not read as a model with no capacity at all.
 *
 * The magnitudes are the adapter's own route-level fallbacks (`llm-pi-ai`'s
 * `defaultContextWindow` and `defaultMaxTokens`), spelled the way a person
 * would say them; the context hint shows only when neither the name-keyed
 * preset nor the installed catalog sizes the model. They are a hint, not a
 * mirror: this page counts `K` as 1000,
 * so typing `256K` stores 256000 while leaving the field blank keeps the
 * adapter's 262144. A deployment that overrides those defaults is not
 * reflected here — nothing on this page can read them.
 */
const CAPACITY_HINT: Readonly<Record<CapacityField, string>> = {
  contextWindow: '256K',
  maxTokens: '32K',
}

/**
 * Spell a stored count for a field that may be unset. The spelling itself is
 * {@link formatCapacity}, shared with the DeepSeek catalog editor so both
 * surfaces read and write one K/M vocabulary.
 * @param value - stored capacity, or `undefined` for an unset field.
 * @returns the field text, empty when unset.
 */
function capacitySpelling(value: number | undefined): string {
  return value === undefined ? '' : formatCapacity(value)
}

/** Adopt a candidate, preserving disclosed capacities and input types. */
function adopt(candidate: LlmDiscoveredModel): ModelDraft {
  return {
    id: candidate.id,
    ...candidate.name === undefined ? {} : { name: candidate.name },
    ...candidate.contextWindow === undefined ? {} : {
      contextWindow: candidate.contextWindow,
      // The listing disclosed this capacity, which keeps the row's source
      // label reading "upstream" until the field is edited by hand.
      contextWindowSource: 'upstream',
    },
    ...candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens },
    ...candidate.inputModalities === undefined ? {} : { input: [...candidate.inputModalities] },
  }
}

/**
 * Render the model list with its fetch action.
 * @param props - the drafted rows, probe target, wire face, and copy.
 * @returns the model-list editor.
 */
export function ModelListEditor(props: ModelListEditorProps): ReactNode {
  const { models, onChange, probe, operations, t, disabled, onBusyChange } = props
  const { catalogProvider } = props
  const [busy, setBusy] = useState(false)
  useEffect(() => { onBusyChange(busy) }, [busy, onBusyChange])
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [inheritedCatalog, setInheritedCatalog] = useState<{
    provider: string
    models: readonly LlmDiscoveredModel[]
  } | undefined>(undefined)
  useEffect(() => {
    if (catalogProvider === undefined) return
    let current = true
    void operations.discoverModels(probe.settingsNs, { provider: catalogProvider }).then((answer) => {
      if (!current) return
      setInheritedCatalog({ provider: catalogProvider, models: answer.kind === 'found' ? answer.models : [] })
      setFailure(answer.kind === 'refused' ? answer.message : undefined)
    })
    return () => { current = false }
  }, [catalogProvider, operations, probe.settingsNs])
  const catalog = inheritedCatalog?.provider === catalogProvider ? inheritedCatalog?.models : undefined
  const reasoningModel = (model: ModelDraft): ModelDraft => {
    if (model['reasoningEfforts'] !== undefined || catalogProvider !== undefined) return model
    const compat = model['compat']
    const support = typeof compat === 'object' && compat !== null && 'supportsReasoningEffort' in compat
      ? compat.supportsReasoningEffort : props.reasoningCompat
    return { ...model, reasoningEfforts: inferReasoningEfforts({
      id: textOf(model, 'id'),
      name: textOf(model, 'name'),
      api: probe.api,
      supportsReasoningEffort: typeof support === 'boolean' ? support : undefined,
    }) }
  }
  const [candidates, setCandidates] = useState<readonly LlmDiscoveredModel[] | undefined>(undefined)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [candidateQuery, setCandidateQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  // Capacities are edited as text, so a field's keystrokes are held here rather
  // than re-derived from the parsed count on every change — that would rewrite
  // `1000` to `1K` mid-word. Unreadable text is kept past blur so the refusal
  // names a row the user can still see, which is why this is one entry PER
  // FIELD: a single buffer would be displaced by editing any other field, and
  // the abandoned one would render its stored NaN as the literal `NaN`.
  const [editing, setEditing] = useState<ReadonlyMap<string, string>>(new Map())

  /** Buffer key for one capacity field; the row half moves when rows do. */
  const bufferKey = (index: number, field: CapacityField): string => `${String(index)}:${field}`

  const editCapacity = (index: number, field: CapacityField, text: string): void => {
    setEditing(current => new Map(current).set(bufferKey(index, field), text))
    // Editing the context window by hand makes the value hand-entered, so the
    // upstream marker leaves together with the value it qualified; clearing the
    // text drops both and the row falls back to its preset or default.
    patch(index, field === 'contextWindow'
      ? { contextWindow: parseCapacity(text), contextWindowSource: undefined }
      : { [field]: parseCapacity(text) })
  }

  /** What a capacity field shows: the buffer while typing, else the stored count. */
  const capacityText = (model: ModelDraft, index: number, field: CapacityField): string =>
    editing.get(bufferKey(index, field)) ?? capacitySpelling(numberOf(model, field))

  /**
   * What an empty context-window field previews: the resolution order this
   * value would take — the name-keyed preset, else the installed catalog's
   * disclosure for the same id, else the route-default hint.
   */
  const contextPlaceholder = (model: ModelDraft): string => {
    const id = textOf(model, 'id')
    if (id.length > 0) {
      const preset = presetContextWindow(id)
      if (preset !== undefined) return formatCapacity(preset)
      const installed = catalog?.find(entry => entry.id === id)?.contextWindow
      if (installed !== undefined) return formatCapacity(installed)
    }
    return CAPACITY_HINT.contextWindow
  }

  /** Drop one row's entries and shift the rows after it down, in one pass. */
  const reindexOnRemove = (
    current: ReadonlyMap<string, string>,
    index: number,
  ): Map<string, string> => {
    const next = new Map<string, string>()
    for (const [key, value] of current) {
      const at = Number(key.slice(0, key.indexOf(':')))
      if (at === index) continue
      // Only the row number moves; the field half of the key is untouched.
      next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, value)
    }
    return next
  }

  const toggleExpanded = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  const patch = (index: number, next: Record<string, string | number | undefined>): void => {
    props.onRowEdited?.(index)
    onChange(models.map((model, at) => {
      if (at !== index) return model
      // Rebuilt rather than spread over: an emptied optional field has to leave
      // the profile, not be stored as a value its schema would reject.
      // Spread first so a field this card does not edit survives; an emptied
      // optional field is then dropped rather than stored as a value its
      // schema would reject.
      const cleared = new Set(
        Object.entries(next).filter(([, value]) => value === undefined || value === '').map(([key]) => key),
      )
      return Object.fromEntries(
        Object.entries({ ...model, ...next }).filter(([key]) => !cleared.has(key)),
      )
    }))
  }

  const fetchModels = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const answer = await operations.discoverModels(probe.settingsNs, {
        ...probe.provider === undefined ? {} : { provider: probe.provider },
        ...probe.baseURL === undefined || probe.baseURL.length === 0 ? {} : { baseURL: probe.baseURL },
        ...probe.api === undefined ? {} : { api: probe.api },
        ...probe.apiKey === undefined ? {} : { apiKey: probe.apiKey },
      })
      if (answer.kind === 'refused') {
        setFailure(answer.message)
        return
      }
      const found = answer.models
      if (catalogProvider !== undefined) setInheritedCatalog({ provider: catalogProvider, models: found })
      if (found.length === 0 && models.length === 0) {
        setFailure(t('fetchEmpty'))
        return
      }
      const selection = defaultRecognizedSelection(found, models.map(model => ({ id: textOf(model, 'id'), name: textOf(model, 'name') })))
      setCandidateQuery('')
      setCandidates(selection.models)
      setPicked(new Set(selection.checked))
    } finally {
      setBusy(false)
    }
  }

  const closePicker = (): void => {
    setCandidates(undefined)
    setPicked(new Set())
    setCandidateQuery('')
  }

  const adoptPicked = async (): Promise<void> => {
    /* v8 ignore next -- the dialog only renders with candidates loaded */
    if (candidates === undefined) return
    const byId = new Map(models.map(model => [textOf(model, 'id'), model]))
    for (let index = models.length - 1; index >= 0; index -= 1) {
      if (!picked.has(textOf(models[index] as ModelDraft, 'id'))) props.onRowRemoved?.(index)
    }
    const next = candidates.filter(candidate => picked.has(candidate.id)).map((candidate, index) => {
      props.onRowEdited?.(index)
      return byId.get(candidate.id) ?? adopt(candidate)
    })
    if (props.onSaveSelection !== undefined) {
      setBusy(true)
      try {
        const failure = await props.onSaveSelection(next)
        if (failure !== undefined) { setFailure(failure); return }
      } finally { setBusy(false) }
    }
    onChange(next)
    setExpanded(new Set())
    setEditing(new Map())
    closePicker()
  }

  const toggle = (id: string): void => {
    setPicked((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const configuredIds = new Set(models.map(model => textOf(model, 'id')))
  const additions = [...picked].filter(id => !configuredIds.has(id)).length
  const removals = [...configuredIds].filter(id => !picked.has(id)).length
  const activeCandidates = candidates ?? []
  const normalizedCandidateQuery = candidateQuery.trim().toLowerCase()
  const visibleCandidates = normalizedCandidateQuery.length === 0
    ? activeCandidates
    : activeCandidates.filter(candidate => candidate.id.toLowerCase().includes(normalizedCandidateQuery)
      || candidate.name?.toLowerCase().includes(normalizedCandidateQuery) === true)
  const allVisibleCandidatesPicked = visibleCandidates.length > 0
    && visibleCandidates.every(candidate => picked.has(candidate.id))

  const toggleVisibleCandidates = (): void => {
    setPicked((current) => {
      if (visibleCandidates.every(candidate => current.has(candidate.id))) {
        return new Set()
      }
      const next = new Set(current)
      for (const candidate of visibleCandidates) next.add(candidate.id)
      return next
    })
  }

  // A route the adapter already describes answers without an endpoint; only a
  // draft with neither has nothing to ask about.
  const askable = probe.provider !== undefined || (probe.baseURL !== undefined && probe.baseURL.length > 0)
  const { autoDiscover } = props
  // The address and the key are what an interrogation answers about, so either
  // one moving is a new question; everything else the form edits is not.
  const askedFor = `${probe.baseURL ?? ''}\u0000${probe.apiKey ?? ''}`
  const asked = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (autoDiscover !== true || !askable || props.probeBlocked !== undefined
      || probe.apiKey === undefined || asked.current === askedFor) return
    asked.current = askedFor
    void fetchModels()
  })
  return (
    <section className={styles['modelCatalog']} aria-label={t('models')}>
      <div className={styles['modelListHead']}>
        <div className={styles['modelCatalogHeading']}>
          <span className={styles['modelCatalogTitle']}>{t('models')}</span>
          {props.overridden === undefined
            ? null
            : (
              <span className={styles['modelCatalogMeta']}>
                {props.overridden ? t('modelsCustomized') : t('modelsInherited')}
              </span>
            )}
        </div>
        {props.overridden === true && props.onReset !== undefined
          ? (
            <button
              type="button"
              className={styles['linkButton']}
              disabled={disabled}
              onClick={props.onReset}
            >
              {t('resetModels')}
            </button>
          )
          : null}
        <button
          type="button"
          className={styles['addModelButton']}
          disabled={disabled || busy || !askable || props.probeBlocked !== undefined}
          title={props.probeBlocked !== undefined
            ? t(props.probeBlocked)
            : askable ? undefined : t('fetchNeedsBaseUrl')}
          onClick={() => { void fetchModels() }}
        >
          {busy ? t('fetching') : t('fetchModels')}
        </button>
      </div>
      {models.length === 0 ? <p className={styles['modelEmpty']}>{t('modelsEmpty')}</p> : null}
      <div className={styles['modelList']}>
        {models.map((model, index) => (
          <ModelRow
            key={index}
            model={model}
            reasoningModel={reasoningModel(model)}
            position={index + 1}
            protocolProbe={props.renderProtocolProbe?.(model)}
            inputField="input"
            inputFallback={props.defaultInput}
            inputLoading={catalogProvider !== undefined && catalog === undefined}
            reasoningLevels={props.reasoningLevels}
            expanded={expanded.has(index)}
            disabled={disabled}
            t={t}
            contextWindow={{
              value: capacityText(model, index, 'contextWindow'),
              placeholder: contextPlaceholder(model),
              source: t(contextSourceKey(model)),
              onChange: (text) => { editCapacity(index, 'contextWindow', text) },
            }}
            maxTokens={{
              value: capacityText(model, index, 'maxTokens'),
              placeholder: CAPACITY_HINT.maxTokens,
              onChange: (text) => { editCapacity(index, 'maxTokens', text) },
            }}
            onFieldChange={(field, value) => { patch(index, { [field]: value }) }}
            onChange={(next) => { props.onRowEdited?.(index); onChange(models.map((row, at) => at === index ? next : row)) }}
            onToggle={() => { toggleExpanded(index) }}
            onRemove={() => {
              props.onRowRemoved?.(index)
              onChange(models.filter((_model, at) => at !== index))
              setExpanded((current) => {
                const next = new Set<number>()
                for (const at of current) {
                  if (at < index) next.add(at)
                  else if (at > index) next.add(at - 1)
                }
                return next
              })
              setEditing(current => reindexOnRemove(current, index))
            }}
          />
        ))}
      </div>
      <button
        type="button"
        className={styles['addModelButton']}
        disabled={disabled}
        onClick={() => { onChange([...models, { id: '' }]) }}
      >
        <IconPlusOutlineRegular size={14} />
        {t('addModel')}
      </button>
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      <Modal
        open={candidates !== undefined}
        onClose={() => { if (!busy) closePicker() }}
        title={t('fetchTitle')}
        closeLabel={t('close')}
        description={t('fetchDescription')}
        className={styles['fetchDialog'] as string}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={closePicker}>{t('cancel')}</Button>
            <Button variant="outline" disabled={busy} onClick={() => { void adoptPicked() }}>{t('fetchAdopt')}</Button>
          </>
        )}
      >
        <div className={styles['candidateToolbar']}>
          <input
            className={`${styles['input']} ${styles['candidateSearch']}`}
            type="search"
            value={candidateQuery}
            placeholder={t('fetchSearch')}
            aria-label={t('fetchSearch')}
            onChange={(event) => { setCandidateQuery(event.target.value) }}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || visibleCandidates.length === 0}
            onClick={toggleVisibleCandidates}
          >
            {t(allVisibleCandidatesPicked ? 'fetchDeselectAll' : 'fetchSelectAll')}
          </Button>
        </div>
        {visibleCandidates.length === 0
          ? <p className={styles['candidateEmpty']} role="status">{t('fetchNoMatches')}</p>
          : (
            <ul className={styles['candidateList']}>
              {visibleCandidates.map(candidate => (
                <li key={candidate.id} className={styles['candidate']}>
                  <label className={styles['candidateLabel']}>
                    <input
                      type="checkbox"
                      checked={picked.has(candidate.id)}
                      disabled={busy}
                      onChange={() => { toggle(candidate.id) }}
                    />
                    <span className={styles['candidateId']} title={candidate.name ?? candidate.id}>
                      {candidate.id}
                    </span>
                    {configuredIds.has(candidate.id) ? <span>{t('recognizedAdded')}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
          )}
        <p role="status">{t('recognizedChanges').replace('{add}', String(additions)).replace('{remove}', String(removals))}</p>
      </Modal>
    </section>
  )
}
