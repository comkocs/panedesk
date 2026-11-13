/** Shared compact delegation form for settings and the new-session dialog. */
import { useState } from 'react'
import { Button, Checkbox, Menu, Modal, SettingsPageHeader, Switch } from '@panedesk/dsh-client-ui-primitives'
import type { ModelCatalog } from '@panedesk/dsh-api-remotes/client'
import { mainDuties, subagentDefaults, subagentTiers } from '../subagent-defaults.ts'
import type { SubagentPresets, SubagentTier } from '../types.ts'
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
  const [menu, setMenu] = useState<{ tier: keyof SubagentPresets['tiers']; effort: boolean; groups: ModelCatalog['groups'] }>()
  if (form.status !== 'ready' || !form.value) return <p>{t(form.status === 'loading' ? 'loading' : 'error')}</p>
  const value = draft?.value ?? form.value.subagentPresets
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
  const openMenu = (tier: keyof SubagentPresets['tiers'], effort: boolean) => {
    setBusy(true); setError('')
    void props.loadSubagentModels().then(groups => setMenu({ tier, effort, groups }))
      .catch(reason => setError(String(reason))).finally(() => setBusy(false))
  }
  return <div className={css.form}>
    <Switch checked={value.enabled} label={t('subagentEnabled')} disabled={disabled} onChange={enabled => change({ ...value, enabled })} />
    {subagentTiers.map(key => {
      const tier = value.tiers[key]
      const models = menu?.groups.flatMap(group => group.models.map(model => ({ id: JSON.stringify([group.id, model.id]), label: `${group.id} / ${model.id}`, provider: group.id, model }))) ?? []
      const efforts = models.find(model => model.provider === tier.provider && model.model.id === tier.model)?.model.reasoning?.efforts ?? []
      const modelId = tier.model ? JSON.stringify([tier.provider, tier.model]) : ''
      return <div className={css.tier} key={key}>
        <strong>{t(`tier_${key}`)}</strong>
        <label className={css.field}>{t('subagentCriteria')}<input value={tier.criteria[language]} disabled={disabled}
          onChange={event => changeTier(key, { criteria: { ...tier.criteria, [language]: event.target.value } })} /></label>
        <div className={css.field}><span>{t('subagentModel')}</span>
          <Menu open={menu?.tier === key && !menu.effort} onClose={() => setMenu(undefined)} portal autoFocus
            selectedId={modelId} items={[{ id: '', label: t('subagentUnspecified') }, ...models]}
            anchor={<Button variant="outline" disabled={disabled} aria-label={`${t(`tier_${key}`)} ${t('subagentModel')}`} aria-haspopup="menu" aria-expanded={menu?.tier === key && !menu.effort}
              onClick={() => openMenu(key, false)}>{tier.model ? `${tier.provider} / ${tier.model}` : t('subagentUnspecified')}</Button>}
            onSelect={id => {
              const selected = models.find(model => model.id === id)
              changeTier(key, { provider: selected?.provider ?? '', model: selected?.model.id ?? '', effort: '' }); setMenu(undefined)
            }} />
        </div>
        <div className={css.field}><span>{t('presetEffort')}</span>
          <Menu open={menu?.tier === key && menu.effort} onClose={() => setMenu(undefined)} portal autoFocus
            selectedId={tier.effort} items={[{ id: '', label: t('defaultEffort') }, ...efforts.map(effort => ({ id: effort.id, label: effort.name }))]}
            anchor={<Button variant="outline" disabled={disabled || !tier.model} aria-label={`${t(`tier_${key}`)} ${t('presetEffort')}`} aria-haspopup="menu" aria-expanded={menu?.tier === key && menu.effort}
              onClick={() => openMenu(key, true)}>{tier.effort || t('defaultEffort')}</Button>}
            onSelect={effort => { changeTier(key, { effort }); setMenu(undefined) }} />
        </div>
      </div>
    })}
    <section className={css.field}>
      <strong>{t('subagentMainDuties')}</strong>
      <div className={css.checks}>{mainDuties.map(key => <Checkbox key={key} className={css.check} label={t(`duty_${key}`)} checked={value.mainDuties[key]} disabled={disabled}
        onChange={checked => change({ ...value, mainDuties: { ...value.mainDuties, [key]: checked } })} />)}</div>
      <p>{t('subagentUnchecked')}</p>
      <label className={css.field}>{t('subagentOther')}<input value={value.otherMainDuties} disabled={disabled}
        onChange={event => change({ ...value, otherMainDuties: event.target.value })} /></label>
    </section>
    <Checkbox className={css.check} label={t('subagentAllowNested')} checked={value.allowNested} disabled={disabled} onChange={allowNested => change({ ...value, allowNested })} />
    <label className={css.field}>{t('subagentNestedCondition')}<input value={value.nestedCondition[language]} disabled={disabled}
      onChange={event => change({ ...value, nestedCondition: { ...value.nestedCondition, [language]: event.target.value } })} /></label>
    <div className={presetCss.actions}>
      <Button variant="primary" disabled={disabled} onClick={() => { void persist(value) }}>{t('save')}</Button>
      <Button variant="outline" disabled={disabled} onClick={() => { void persist(subagentDefaults) }}>{t('restoreDefault')}</Button>
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
