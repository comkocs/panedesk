/** Localized introductions shown above every Panedesk settings section. */
import { SettingsPageHeader } from '@panedesk/dsh-client-ui-primitives'
import type { SettingsRootComponentProps } from './shell-contract.ts'

const pages = {
  'panedesk-features': 'features',
  'product-features': 'product',
  tools: 'tools',
  'project-opening': 'project',
  'database-connections': 'database',
  'seat-profiles': 'profiles',
  skills: 'skills',
  stats: 'stats',
  'data-storage': 'storage',
  nodes: 'nodes',
} as const

/**
 * Keep guidance visible even while a feature page is loading or unavailable.
 * @param props - Active section identity and the shell's locale translator.
 * @returns Three guidance lines and optional first-use instructions.
 */
export function PanedeskGuidance({ id, t }: { id: string; t: SettingsRootComponentProps['t'] }) {
  const page = pages[id as keyof typeof pages]
  const steps = page === 'project' || page === 'database' || page === 'skills'
    ? [t(`guidance.${page}.step1`), t(`guidance.${page}.step2`), t(`guidance.${page}.step3`)] as const : undefined
  return <SettingsPageHeader
    what={page ? t(`guidance.${page}.what`) : t('guidance.other.what')}
    whether={page ? t(`guidance.${page}.whether`) : t('guidance.default')}
    ai={page ? t(`guidance.${page}.ai`) : t('guidance.manual')}
    {...steps === undefined ? {} : { steps }}
    labels={{ what: t('guidance.what'), whether: t('guidance.whether'), ai: t('guidance.ai'),
      copy: t('guidance.copy'), copied: t('guidance.copied'), copyFailed: t('guidance.copyFailed'), once: t('guidance.once') }} />
}
