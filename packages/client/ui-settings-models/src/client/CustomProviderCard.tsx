/**
 * The card that declares a provider pi-ai does not ship — an OpenAI-compatible
 * gateway, a self-hosted server, or a provider newer than the installed
 * catalog.
 *
 * This is a create, not an edit, which is why it is its own form rather than
 * the provider editor with extra fields: the route id is generated from the
 * display name or endpoint hostname, and its settings address is new. It renders as the
 * custom-API panel of the section's add card; the card's mode switch names it
 * when both modes are offered, and with the custom mode alone the card shows
 * this form directly. One `settings.mutate` sets the whole profile at
 * `providers.<route>`; the key travels separately through `credentials/set`
 * under the reference the profile records, exactly as an existing provider's
 * key does.
 *
 * The three fields a hand-declared route cannot default — endpoint, protocol,
 * and at least one model — are required here rather than at load, so the
 * failure names the field while the user is still looking at it.
 *
 * There is deliberately no provider-scoped reasoning-effort control, here or
 * on the editor card: effort is a per-MODEL capability, and the models under
 * one provider disagree about it, so a provider-scoped control can only be set
 * to a value some of them reject. Each model row of a hand-declared route
 * declares its own `reasoningEfforts` instead, and the composer's model picker
 * offers each model those levels.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { JsonValue } from '@panedesk/dsh-util-values'
import { apiKeyFailure } from './apiKey.ts'
import { ApiKeyInput } from './ApiKeyInput.tsx'
import { EditorFooter } from './EditorFooter.tsx'
import { validateDeepSeekModels } from './DeepSeekModelsEditor.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import { ProtocolProbe } from './ProtocolProbe.tsx'
import type { ModelDraft } from './ModelListEditor.tsx'
import { validateReasoningEfforts } from './ModelReasoningEfforts.tsx'
import { deriveKeyRef } from './store.ts'
import { protocolLabel } from './protocol-label.ts'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The settings namespace a hand-declared provider is written into. */
const NS = 'llm-pi-ai'

/** Keep generated ids usable as credential stems and distinct from existing routes. */
function generatedRoute(name: string, baseURL: string, taken: readonly string[]): string {
  const source = name.trim() || (isHttpUrl(baseURL) ? new URL(baseURL).hostname : '')
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'provider'
  // Credential references are shell identifiers, so their stem must start with a letter.
  const stem = /^[a-z]/.test(slug) ? slug : `provider-${slug}`
  let route = stem
  for (let suffix = 2; taken.includes(route); suffix += 1) route = `${stem}-${String(suffix)}`
  return route
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Props of {@link CustomProviderCard}. */
export interface CustomProviderCardProps {
  /** Route ids already declared, so the card refuses to shadow one. */
  taken: readonly string[]
  /** Wire protocols the adapter can serve, in the order it reports them. */
  protocols: readonly string[]
  /** Reasoning levels the adapter's schema accepts, in escalation order; empty shows no reasoning control. */
  reasoningLevels: readonly string[]
  /**
   * Revision of the `llm-pi-ai` user section this card opened at, sent with
   * the create so a route another tab declared meanwhile is a refusal rather
   * than a silent overwrite of its whole profile.
   */
  revision: number
  /** The Host operations this card writes and interrogates through. */
  operations: ModelsOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Close the card; `changed` reports whether a provider was created. */
  onClose: (changed: boolean) => void
  /**
   * Called once per change with whether the create or the list's endpoint
   * interrogation is in flight, so the owner can hold its surface still.
   */
  onBusyChange?: (busy: boolean) => void
  /**
   * Mirror the create action into the add card's header: called with the
   * action's state whenever it changes, and with undefined on unmount.
   */
  onHeaderAction?: (action: CreateAction | undefined) => void
}

/** The create action as the add card's header button shows it. */
export interface CreateAction {
  disabled: boolean
  busy: boolean
  run: () => void
}

/**
 * Render the custom-provider creation card.
 * @param props - existing routes, protocol choices, wire faces, and copy.
 * @returns the creation card.
 */
export function CustomProviderCard(props: CustomProviderCardProps): ReactNode {
  const { taken, protocols, reasoningLevels, operations, t, onBusyChange } = props
  // The write is checked against the revision on which this draft was opened.
  const [openedAt] = useState(() => props.revision)
  const [displayName, setDisplayName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [protocol, setProtocol] = useState(protocols[0] ?? '')
  const [keyDraft, setKeyDraft] = useState('')
  const [models, setModels] = useState<readonly ModelDraft[]>([])
  /**
   * Rows the user has typed into, by position. A row added and left untouched
   * is not a model yet, so it neither blocks creation nor is stored.
   */
  const [touched, setTouched] = useState<ReadonlySet<number>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [listBusy, setListBusy] = useState(false)
  useEffect(() => { onBusyChange?.(busy || listBusy) }, [busy, listBusy, onBusyChange])
  const [failure, setFailure] = useState<string | undefined>(undefined)
  /**
   * The profile write landed. Only the key write can still be outstanding, so
   * the fields that describe the provider are settled and the retry path is
   * the credential alone.
   */
  const [committedRoute, setCommittedRoute] = useState<string | undefined>(undefined)
  const committed = committedRoute !== undefined
  const disabled = props.readOnly || busy || listBusy
  /** Everything but the key stops being editable once the provider exists. */
  const profileDisabled = disabled || committed

  const normalizedBaseURL = baseURL.trim()
  const route = committedRoute ?? generatedRoute(displayName, normalizedBaseURL, taken)
  const baseUrlInvalid = baseURL.length > 0 && !isHttpUrl(normalizedBaseURL)
  // Rows are checked by the same per-row validator the editor cards use, so a
  // bad row is named by its position here too. Capacities have route-level
  // fallbacks; what a route cannot default is at least one model. Every row of
  // this hand-declared route edits its reasoning levels, so they are checked too.
  const storedModels = models.filter((_model, index) => touched.has(index))
  const modelFailure = validateDeepSeekModels(storedModels) ?? validateReasoningEfforts(storedModels)
  const keyFailure = apiKeyFailure(keyDraft)
  // The typed key with paste whitespace removed. A blank field yields an empty
  // string, which the create path reads as "no key supplied" — a route may
  // legitimately authenticate through the provider's own ambient discovery.
  const keyValue = keyDraft.trim()
  const ready = normalizedBaseURL.length > 0 && !baseUrlInvalid && modelFailure === undefined
    && keyFailure === undefined
  // The one blocked gate worth a line under the form. A satisfied card says
  // nothing at all rather than printing an empty paragraph.
  const hint = failure !== undefined || ready
    // The key field prints its own failure directly beneath itself, so a card
    // blocked only by the key stays silent here rather than answering with the
    // next unmet gate — which is satisfied, and reads as a second, false fault.
    || keyFailure !== undefined
    || baseUrlInvalid
    ? undefined
    : normalizedBaseURL.length === 0
      ? t('customNeedsBaseUrl')
      : modelFailure !== undefined
        ? `${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`
        : t('customNeedsModels')

  /** Perform the create, returning a failure message or undefined. */
  const createOnce = async (): Promise<string | undefined> => {
    const keyRef = deriveKeyRef(route)
    const storesKey = keyValue.length > 0
    if (!committed) {
      const profile = {
        ...displayName.length === 0 ? {} : { displayName },
        // The profile names the conventional reference only when this card is
        // about to store a key, matching the editor: a route declared with the
        // key left blank keeps its provider-native auth path (a credential
        // chain, ADC) instead of resolving a reference nothing ever sets.
        ...storesKey ? { apiKeyEnv: keyRef } : {},
        api: protocol,
        baseURL: normalizedBaseURL,
        models: storedModels.map(model => ({ ...model })),
      }
      // `taken` is a snapshot too, so the id check alone cannot see a route
      // declared after this card opened; the revision makes that race a
      // `settings-conflict` instead of a write over the other profile.
      const written = await operations.writeSettings(
        NS,
        [{ op: 'set', path: ['providers', route], value: profile as JsonValue }],
        openedAt,
      )
      if (written.kind !== 'written') {
        return written.kind === 'conflict' ? t('conflict') : written.message
      }
      // The provider now exists. A retry after the key write below fails must
      // not re-run this mutate: the revision it holds is the one this write
      // just superseded, so the Host would answer `settings-conflict` and the
      // key could never be stored from this card at all.
      setCommittedRoute(route)
    }
    if (storesKey) {
      const stored = await operations.storeCredential(keyRef, keyValue)
      // The profile landed; saying the key did not is the only honest report,
      // and the retry above now goes straight back to this write.
      if (stored !== undefined) return stored
    }
    return undefined
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const outcome = await createOnce()
      if (outcome !== undefined) {
        setFailure(outcome)
        return
      }
      props.onClose(true)
    } finally {
      setBusy(false)
    }
  }
  // The header button runs the latest draft's create, not the one it was handed.
  const createRef = useRef(create)
  createRef.current = create
  const { onHeaderAction } = props
  const submitDisabled = disabled || !ready
  useEffect(() => {
    onHeaderAction?.({ disabled: submitDisabled, busy, run: () => { void createRef.current() } })
  }, [onHeaderAction, submitDisabled, busy])
  useEffect(() => () => { onHeaderAction?.(undefined) }, [onHeaderAction])

  return (
    <div className={styles['editor']}>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customDisplayName')}</span>
        <input
          className={styles['input']}
          type="text"
          value={displayName}
          placeholder={t('customDisplayName')}
          aria-label={t('customDisplayName')}
          disabled={profileDisabled}
          onChange={(event) => { setDisplayName(event.target.value) }}
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
        <input
          className={styles['input']}
          type="text"
          value={baseURL}
          placeholder={t(protocol === 'anthropic-messages'
            ? 'customAnthropicBaseUrlPlaceholder'
            : 'customBaseUrlPlaceholder')}
          aria-label={t('baseUrl')}
          aria-invalid={baseUrlInvalid}
          disabled={profileDisabled}
          onChange={(event) => { setBaseURL(event.target.value) }}
        />
      </div>
      {baseUrlInvalid ? <p className={styles['error']}>{t('customBaseUrlInvalid')}</p> : null}
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customApi')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={protocol}
          aria-label={t('customApi')}
          disabled={profileDisabled}
          onChange={(event) => { setProtocol(event.target.value) }}
        >
          {protocols.map(choice => <option key={choice} value={choice}>{protocolLabel(t, choice)}</option>)}
        </select>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('keyInput')}</span>
        <ApiKeyInput
          t={t}
          value={keyDraft}
          placeholder={t('keyPlaceholder')}
          aria-label={t('keyInput')}
          disabled={disabled}
          onChange={(event) => { setKeyDraft(event.target.value) }}
        />
        {/* A create card has no stored key to keep, so the blank case says
            what a blank field means here instead: this route may authenticate
            through the provider's own ambient discovery or OAuth. */}
        {keyFailure === undefined
          ? null
          : <p className={styles['error']}>{t(keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure)}</p>}
      </div>
      <ModelListEditor
        models={models}
        renderProtocolProbe={model => <ProtocolProbe
          target={{ settingsNs: NS, provider: route, baseURL: normalizedBaseURL, api: protocol,
            ...keyValue.length === 0 ? {} : { apiKey: keyValue } }}
          model={model['id'] as string} imageDeclared={Array.isArray(model['input']) && model['input'].includes('image')}
          operations={operations} t={t} disabled={profileDisabled}
          onBusyChange={setListBusy} onSaved={() => { props.onClose(true) }}
        />}
        onChange={setModels}
        onRowEdited={(index) => { setTouched(current => new Set(current).add(index)) }}
        onRowRemoved={(index) => {
          setTouched((current) => {
            const next = new Set<number>()
            for (const at of current) {
              if (at < index) next.add(at)
              else if (at > index) next.add(at - 1)
            }
            return next
          })
        }}
        autoDiscover={!models.some((_model, index) => touched.has(index))}
        reasoningLevels={reasoningLevels}
        probe={{
          settingsNs: NS,
          baseURL: normalizedBaseURL,
          api: protocol,
          ...keyValue.length === 0 ? {} : { apiKey: keyValue },
        }}
        probeBlocked={baseUrlInvalid
          ? 'customBaseUrlInvalid'
          : keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure}
        operations={operations}
        t={t}
        disabled={profileDisabled}
        onBusyChange={setListBusy}
      />
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      {hint === undefined ? null : <p className={styles['advancedHint']}>{hint}</p>}
      <EditorFooter
        t={t}
        busy={busy}
        submitDisabled={disabled || !ready}
        submitLabelKey="create"
        submitBusyLabelKey="creating"
        onCancel={() => { props.onClose(committed) }}
        onSubmit={() => { void create() }}
      />
    </div>
  )
}
