/** Session credentials are ephemeral capabilities, not durable authorization facts. */
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { HostAdminEndpoint } from './index.ts'
import type { PrivateFiles } from './private-files.ts'
import type { HostSessionBinding, HostSessionCredential, HostSessionCredentials, HostSdkIdentity } from './sdk.ts'

interface Entry {
  credential: string
  identity: HostSdkIdentity
  revoke(): Promise<void>
}
/** One running administration listener owns all session capabilities and their cleanup. */
export class SessionCredentials implements HostSessionCredentials {
  private readonly entries = new Map<HostSessionBinding['sessionId'], Entry>()
  private readonly work = new Set<Promise<unknown>>()
  private readonly versions = new Map<HostSessionBinding['sessionId'], object>()
  private stopped = false
  constructor(private readonly directory: string, private readonly epoch: HostAdminEndpoint['processEpoch'],
    private readonly files: (directory: string) => PrivateFiles) {}

  /** Snapshot only currently valid authentication alternatives.
   * @returns Listener-private credentials with opaque host identities.
   */
  authentication(): readonly { credential: string; epoch: string; identity: HostSdkIdentity }[] {
    return [...this.entries.values()].map(entry => ({ credential: entry.credential, epoch: this.epoch, identity: entry.identity }))
  }
  /** Recover only an identity owned by this live registry.
   * @param value - Opaque transport-authenticated identity.
   * @returns Live binding or undefined after revocation.
   */
  identity(value: object | undefined): HostSdkIdentity | undefined {
    return [...this.entries.values()].find(entry => entry.identity === value)?.identity
  }
  async issue(binding: HostSessionBinding): Promise<HostSessionCredential> {
    if (this.stopped) throw new Error('Session credential issuer is closed')
    const previous = this.revoke(binding.sessionId)
    const version = {}
    this.versions.set(binding.sessionId, version)
    const task = this.publish(binding, version, previous)
    this.work.add(task)
    try { return await task } finally { this.work.delete(task) }
  }
  private async publish(binding: HostSessionBinding, version: object, previous: Promise<void>): Promise<HostSessionCredential> {
    await previous
    if (this.versions.get(binding.sessionId) !== version) throw new Error('Session credential was revoked')
    const directory = join(this.directory, `session-${randomUUID()}`)
    const files = this.files(directory)
    const controller = new AbortController()
    const credential = randomBytes(32).toString('hex')
    const identity: HostSdkIdentity = Object.freeze({ principalId: `session:${binding.sessionId}` as HostSdkIdentity['principalId'],
      authorizationRef: randomUUID() as HostSdkIdentity['authorizationRef'], sessionId: binding.sessionId,
      seat: binding.seat, ...(binding.staffId === undefined ? {} : { staffId: binding.staffId }), signal: controller.signal })
    let removal: Promise<void> | undefined
    const entry: Entry = { credential, identity, revoke: () => {
      controller.abort()
      if (this.entries.get(binding.sessionId) === entry) this.entries.delete(binding.sessionId)
      removal ??= files.remove('credential')
      return removal
    } }
    await files.write('credential', credential)
    if (this.versions.get(binding.sessionId) !== version) {
      await entry.revoke(); throw new Error('Session credential was revoked')
    }
    this.entries.set(binding.sessionId, entry)
    return { endpointPath: join(this.directory, 'endpoint.json'), credentialPath: join(directory, 'credential'),
      processEpoch: this.epoch, revoke: () => entry.revoke() }
  }
  async revoke(sessionId: HostSessionBinding['sessionId']): Promise<void> {
    this.versions.delete(sessionId)
    await this.entries.get(sessionId)?.revoke()
  }
  /** Stop publication, cancel admitted work and remove owned credential files. */
  async close(): Promise<void> {
    this.stopped = true
    this.versions.clear()
    await Promise.allSettled([...this.work])
    const revoked = await Promise.allSettled([...this.entries.values()].map(entry => entry.revoke()))
    if (revoked.some(result => result.status === 'rejected')) throw new Error('Session credential cleanup failed')
  }
}
