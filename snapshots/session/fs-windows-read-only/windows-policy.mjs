/** Test-only Windows default selection; filesystem execution remains on the real host platform. */
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'

export default class WindowsPolicy extends SandboxPolicyService {
  constructor(ctx, config) {
    if (process.env.PANEDESK_PERMISSION_MODE) throw new Error('This fixture requires an unset permission mode')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    if (platform === undefined) throw new Error('Missing process platform descriptor')
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      super(ctx, config)
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  }
}
