/** Seat creation contributes only host-issued credential paths to shell environments. */
import type { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import type { EngineOpenData } from '@panedesk/dsh-seat'
import type { HostSessionCredential } from '@panedesk/dsh-host-admin'
import type {} from '@panedesk/dsh-shell-env'

/** Bind unpublished agents before tools can run; absence preserves ordinary creation.
 * @param ctx - Executor lifecycle and optional credential issuer.
 * @returns Awaited setup hook for creation and resume.
 */
export function sessionCredentialSetup(ctx: Context): (agent: Agent, open: EngineOpenData) => Promise<void> {
  const credentials = new Map<Agent['id'], HostSessionCredential>()
  ctx.inject(['shellEnv', 'hostSessionCredentials'], (child) => {
    child.shellEnv.register({ name: 'host-session-credentials', variables: {
      DSH_HOST_ENDPOINT_PATH: { description: 'Private endpoint descriptor for the running host.' },
      DSH_HOST_CREDENTIAL_PATH: { description: 'Private credential file bound to this session.' },
    }, resolve: (execution) => {
      const credential = execution.agent === undefined ? undefined : credentials.get(execution.agent.id)
      return credential === undefined ? {} : {
        DSH_HOST_ENDPOINT_PATH: credential.endpointPath,
        DSH_HOST_CREDENTIAL_PATH: credential.credentialPath,
      }
    } })
  })
  ctx.effect(() => async () => {
    await Promise.all([...credentials.values()].map(credential => credential.revoke()))
    credentials.clear()
  })
  return async (agent, open) => {
    const issuer = ctx.get('hostSessionCredentials')
    if (issuer === undefined || open.binding.kind !== 'seat') return
    const credential = await issuer.issue({ sessionId: agent.session.id, seat: open.binding.seat })
    credentials.set(agent.id, credential)
    try {
      agent.ctx.effect(() => async () => {
        if (credentials.get(agent.id) === credential) credentials.delete(agent.id)
        await credential.revoke()
      })
    } catch (error) {
      if (credentials.get(agent.id) === credential) credentials.delete(agent.id)
      await credential.revoke()
      throw error
    }
  }
}
