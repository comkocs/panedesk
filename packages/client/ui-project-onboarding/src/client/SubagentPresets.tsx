/** Shared compact delegation form for settings and the new-session dialog. */
import { useState } from 'react'
import { Button, Checkbox, Menu, Modal, SettingsPageHeader, Switch } from '@panedesk/dsh-client-ui-primitives'
import type { ModelCatalog } from '@panedesk/dsh-api-remotes/client'
import { mainDuties, readSubagentTier, subagentDefaults, subagentSizes, subagentTiers } from '../subagent-defaults.ts'
import type { SubagentModel, SubagentPresets, SubagentTier } from '../types.ts'
import type { SubagentProps, SubagentQuickProps, SubagentSettingsProps } from './subagent-props.ts'
import css from './SubagentPresets.module.css'
import presetCss from './OpeningPresets.module.css'

function Form(props: SubagentProps) {
  const { t } = props
  const form = props.useSubagentPresets(value => value)
  const language = props.useSubagentLocale(value => value.active === 'zh' ? 'zh' : 'en')
  const [draft, setDraft] = useState<{ value: SubagentPresets; revision: number | undefined }>()
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState<{ tier: keyof SubagentPresets['tiers']; kind: 'model' | 'effort' | 'size' }>()
  const [groups, setGroups] = useState<ModelCatalog['groups']>([])
  const emptyModel: SubagentModel = { provider: '', model: '', effort: '', size: 'large' }
  const [picks, setPicks] = useState<Record<keyof SubagentPresets['tiers'], SubagentModel>>({ a: emptyModel, b: emptyModel, c: emptyModel })
  if (form.status !== 'ready' || !form.value) return <p>{t(form.status === 'loading' ? 'loading' : 'error')}</p>
  const stored = draft?.value ?? form.value.subagentPresets
  const value = { ...stored, tiers: { a: readSubagentTier(stored.tiers.a), b: readSubagentTier(stored.tiers.b), c: readSubagentTier(stored.tiers.c) } }
  const disabled = busy || !form.writable
  const change = (next: SubagentPresets) => { setDraft({ value: next, revision: draft ? draft.revision : form.revision }); setSaved(false) }
  const changeTier = (key: keyof SubagentPresets['tiers'], next: Partial<SubagentTier>) => change({ ...value, tiers: { ...value.tiers, [key]: { ...value.tiers[key], ...next } } })
  const persist = async (next: SubagentPresets) => {
    setBusy(true); setSaved(false); setError('')
    try {
      if (!await props.saveSubagentPresets({ ...next, language }, draft ? draft.revision : form.revision)) throw new Error(t('presetSaveFailed'))
      setDraft(undefined); setSaved(true)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const openMenu = (tier: keyof SubagentPresets['tiers'], kind: 'model' | 'effort') => {
    setBusy(true); setError('')
    void props.loadSubagentModels().then(groups => { setGroups(groups); setMenu({ tier, kind }) })
      .catch(reason => setError(String(reason))).finally(() => setBusy(false))
  }
  return <div className={css.form}>
    <label className={css.toggle}><Switch checked={value.enabled} label={t('subagentEnabled')} disabled={disabled} onChange={enabled => change({ ...value, enabled })} /><span>{t('subagentEnabled')}</span></label>
    {subagentTiers.map(key => {
      const tier = value.tiers[key]
      const pick = picks[key]
      const changePick = (next: Partial<SubagentModel>) => setPicks({ ...picks, [key]: { ...pick, ...next } })
      const models = groups.flatMap(group => group.models.map(model => ({ id: JSON.stringify([group.id, model.id]), label: `${group.id} / ${model.id}`, provider: group.id, model })))
      const efforts = models.find(model => model.provider === pick.provider && model.model.id === pick.model)?.model.reasoning?.efforts ?? []
      const modelId = pick.model ? JSON.stringify([pick.provider, pick.model]) : ''
      const bands = value.sizes.enabled ? subagentSizes : ['all'] as const
      return <section className={css.tier} key={key}>
        <label className={css.field}><strong>{t(`tier_${key}`)}</strong><input aria-label={`${t(`tier_${key}`)} ${t('subagentCriteria')}`} value={tier.criteria[language]} disabled={disabled}
          onChange={event => changeTier(key, { criteria: { ...tier.criteria, [language]: event.target.value } })} /></label>
        <div className={css.modelRow}>
          <Menu open={menu?.tier === key && menu.kind === 'model'} onClose={() => setMenu(undefined)} portal autoFocus
            selectedId={modelId} items={[{ id: '', label: t('subagentUnspecified') }, ...models]}
            anchor={<Button variant="outline" disabled={disabled} aria-label={`${t(`tier_${key}`)} ${t('subagentModel')}`} aria-haspopup="menu" aria-expanded={menu?.tier === key && menu.kind === 'model'}
              onClick={() => openMenu(key, 'model')}>{pick.model ? `${pick.provider} / ${pick.model}` : t('subagentUnspecified')}</Button>}
            onSelect={id => {
              const selected = models.find(model => model.id === id)
              changePick({ provider: selected?.provider ?? '', model: selected?.model.id ?? '', effort: '' }); setMenu(undefined)
            }} />
          <Menu open={menu?.tier === key && menu.kind === 'effort'} onClose={() => setMenu(undefined)} portal autoFocus
            selectedId={pick.effort} items={[{ id: '', label: t('defaultEffort') }, ...efforts.map(effort => ({ id: effort.id, label: effort.name }))]}
            anchor={<Button variant="outline" disabled={disabled || !pick.model} aria-label={`${t(`tier_${key}`)} ${t('presetEffort')}`} aria-haspopup="menu" aria-expanded={menu?.tier === key && menu.kind === 'effort'}
              onClick={() => openMenu(key, 'effort')}>{pick.effort || t('defaultEffort')}</Button>}
            onSelect={effort => { changePick({ effort }); setMenu(undefined) }} />
          {value.sizes.enabled && <Menu open={menu?.tier === key && menu.kind === 'size'} onClose={() => setMenu(undefined)} portal autoFocus
            selectedId={pick.size} items={subagentSizes.map(size => ({ id: size, label: t(`size_${size}`) }))}
            anchor={<Button variant="outline" disabled={disabled} aria-label={`${t(`tier_${key}`)} ${t('subagentSize')}`} aria-haspopup="menu" aria-expanded={menu?.tier === key && menu.kind === 'size'}
              onClick={() => setMenu({ tier: key, kind: 'size' })}>{t(`size_${pick.size}`)}</Button>}
            onSelect={size => { changePick({ size: size as SubagentModel['size'] }); setMenu(undefined) }} />}
          <Button variant="outline" disabled={disabled || !pick.model} onClick={() => changeTier(key, { models: [...tier.models, { ...pick, size: value.sizes.enabled ? pick.size : 'all' }] })}>{t('subagentAdd')}</Button>
        </div>
        <div className={css.modelList}>{bands.map(size => {
          const choices = tier.models.map((model, index) => ({ model, index })).filter(({ model }) => !value.sizes.enabled || model.size === 'all' || model.size === size)
          return <div className={css.modelGroup} key={size}>
            {value.sizes.enabled && <span className={css.hint}>{t(`size_${size}`)}</span>}
            <div className={css.chips}>{choices.length ? choices.map(({ model, index }) => <span className={css.chip} key={index}>
              <span>{model.provider} / {model.model} · {model.effort || t('defaultEffort')}</span>
              <Button variant="ghost" size="sm" disabled={disabled} aria-label={`${t('deletePreset')} ${model.provider} / ${model.model}`} onClick={() => changeTier(key, { models: tier.models.filter((_, at) => at !== index) })}>×</Button>
            </span>) : <span className={css.hint}>{t('subagentNoModels')}</span>}</div>
          </div>
        })}</div>
      </section>
    })}
    <section className={css.section}>
      <strong>{t('subagentSizes')}</strong>
      <label className={css.toggle}><Switch checked={value.sizes.enabled} label={t('subagentSizesEnabled')} disabled={disabled} onChange={enabled => change({ ...value, sizes: { ...value.sizes, enabled } })} /><span>{t('subagentSizesEnabled')}</span></label>
      {value.sizes.enabled && subagentSizes.map(size => <label className={css.field} key={size}><span>{t(`size_${size}`)}</span><input value={value.sizes[size][language]} disabled={disabled}
        onChange={event => change({ ...value, sizes: { ...value.sizes, [size]: { ...value.sizes[size], [language]: event.target.value } } })} /></label>)}
    </section>
    <section className={css.section}>
      <strong>{t('subagentMainDuties')}</strong>
      <div className={css.checks}>{mainDuties.map(key => <Checkbox key={key} className={css.check} label={t(`duty_${key}`)} checked={value.mainDuties[key]} disabled={disabled}
        onChange={checked => change({ ...value, mainDuties: { ...value.mainDuties, [key]: checked } })} />)}</div>
      <p>{t('subagentUnchecked')}</p>
      <label className={css.field}><span>{t('subagentOther')}</span><input value={value.otherMainDuties} disabled={disabled}
        onChange={event => change({ ...value, otherMainDuties: event.target.value })} /></label>
    </section>
    <section className={css.section}>
      <Checkbox className={css.check} label={t('subagentAllowNested')} checked={value.allowNested} disabled={disabled} onChange={allowNested => change({ ...value, allowNested })} />
      <label className={css.field}><span>{t('subagentNestedCondition')}</span><input value={value.nestedCondition[language]} disabled={disabled}
        onChange={event => change({ ...value, nestedCondition: { ...value.nestedCondition, [language]: event.target.value } })} /></label>
    </section>
    <div className={presetCss.actions}>
      <Button variant="primary" disabled={disabled} onClick={() => { void persist(value) }}>{t('save')}</Button>
      <Button variant="outline" disabled={disabled} onClick={() => { setPicks({ a: emptyModel, b: emptyModel, c: emptyModel }); void persist(subagentDefaults) }}>{t('restoreDefault')}</Button>
      {saved && <span className={presetCss.saved} role="status" onAnimationEnd={() => setSaved(false)}>{t('subagentSaved')}</span>}
    </div>
    {!form.writable && <p>{t('readonly')}</p>}
    {error && <p role="alert">{error}</p>}
  </div>
}

/** Show the same delegation form beneath the standard settings introduction.
 * @param props - Product preferences, locale, and catalog actions.
 * @returns The Panedesk settings page.
 */
export function SubagentSettings(props: SubagentSettingsProps) {
  const { t } = props
  return <section className={css.form}>
    <SettingsPageHeader what={t('subagentWhat')} whether={t('subagentWhether')} ai={t('subagentAi')}
      labels={{ what: t('headerWhat'), whether: t('headerWhether'), ai: t('headerAi'), copy: t('copy'), copied: t('copied'), copyFailed: t('copyFailed'), once: t('once') }} />
    <Form {...props} />
  </section>
}

/** Open a dialog without navigating away from the new-session screen.
 * @param props - The same product preferences and actions as the settings page.
 * @returns A compact entry button and its shared form dialog.
 */
export function SubagentQuick(props: SubagentQuickProps) {
  const [open, setOpen] = useState(false)
  return <>
    <Button variant="outline" size="sm" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>{props.t('subagentTitle')}</Button>
    <Modal className={css.modal!} open={open} title={props.t('subagentTitle')} closeLabel={props.t('close')} closeOnMaskClick={false} onClose={() => setOpen(false)}>
      {open && <Form {...props} />}
    </Modal>
  </>
}
