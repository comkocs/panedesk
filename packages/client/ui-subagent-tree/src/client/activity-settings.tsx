/** Workspace-keyed literal command rule editor using the existing configuration form. */
import { useState } from 'react'
import { Button, Input, Menu } from '@panedesk/dsh-client-ui-primitives'
import type { ActivityCategory, ActivityRule } from '@panedesk/dsh-activity-category/types'
import type { ConfigForm } from '@panedesk/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'

/** Persisted active-profile rules keyed by canonical workspace directory. */
export interface ActivitySettings { projects: Record<string, ActivityRule[]> }

/** Configuration source and revision-aware save action supplied by registration. */
export interface ActivitySettingsFace {
  hooks: { activityRules: ConfigForm<ActivitySettings> }
  saveRules(path: string, rows: ActivityRule[]): Promise<boolean>
}

/** Workspace settings with immediate-save rule rows and visible write failures.
 * @param props Framework workspace/configuration hooks and localized copy.
 * @returns Workspace selection followed by command/category rows.
 */
export function ActivitySettingsRow({ useWorkspaces, useActivityRules, saveRules, t }:
  PropsRuntime<'settings.panedesk.item'> & PropsLocale<'subagentTree'> & InjectFace<ActivitySettingsFace>) {
  const workspaces = useWorkspaces(value => value.items)
  const form = useActivityRules(value => value)
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const path = selected ?? workspaces[0]?.path
  const rows = path === undefined ? [] : form.value?.projects[path] ?? []
  const disabled = path === undefined || form.status !== 'ready' || !form.writable
  const save = (next: ActivityRule[]): void => {
    if (path === undefined) return
    setFailed(false)
    void saveRules(path, next).then(ok => { setFailed(!ok) }).catch(() => { setFailed(true) })
  }
  const categories: ActivityCategory[] = ['write', 'read', 'build', 'test-focused', 'test-full', 'mutation', 'client', 'ci', 'script', 'wait', 'model', 'other']
  return <section>
    <h3>{t('activityRules')}</h3><p>{t('activityRulesHint')}</p>
    <Menu open={menu === 'workspace'} portal onClose={() => { setMenu(null) }} selectedId={path}
      anchor={<Button variant="outline" aria-label={t('activityWorkspace')} onClick={() => { setMenu('workspace') }}>{path ?? t('activityChooseWorkspace')}</Button>}
      items={workspaces.map(item => ({ id: item.path, label: item.title }))}
      onSelect={value => { setSelected(value); setMenu(null) }} />
    {rows.map((row, index) => <div key={index}>
      <label>{t('activityContains')}<Input value={row.contains} disabled={disabled}
        onChange={event => { save(rows.map((item, at) => at === index ? { ...item, contains: event.target.value } : item)) }} /></label>
      <Menu open={menu === String(index)} portal onClose={() => { setMenu(null) }} selectedId={row.category}
        anchor={<Button variant="outline" disabled={disabled} aria-label={t('activityCategory')} onClick={() => { setMenu(String(index)) }}>{t(`category.${row.category}`)}</Button>}
        items={categories.map(id => ({ id, label: t(`category.${id}`) }))}
        onSelect={value => { save(rows.map((item, at) => at === index ? { ...item, category: value as ActivityCategory } : item)); setMenu(null) }} />
      <Button variant="ghost" disabled={disabled} onClick={() => { save(rows.filter((_, at) => at !== index)) }}>{t('activityRemove')}</Button>
    </div>)}
    <Button variant="outline" disabled={disabled} onClick={() => { save([...rows, { contains: '', category: 'client' }]) }}>{t('activityAdd')}</Button>
    {failed && <p role="alert">{t('registrySaveFailed')}</p>}
  </section>
}
