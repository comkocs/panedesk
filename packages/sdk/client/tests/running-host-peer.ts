/** Test-only source subprocess; no profile, engine or stdio SDK runtime is launched. */
import { HarnessClient } from '../src/client.ts'

async function main(): Promise<void> {
  const endpointPath = process.argv[2], credentialPath = process.argv[3], method = process.argv[4]
  if (!endpointPath || !credentialPath || !method) throw new Error('Missing test paths')
  const client = new HarnessClient({ runningHost: { endpointPath, credentialPath,
    maxFrameBytes: 65536, requestTimeoutMs: 5000, maxPending: 4 } })
  try {
    const result = await client.request(method, { sessionId: 'forged-session', seat: 'forged-seat', by: 'forged-staff' })
    if (client.processIdentity !== undefined) throw new Error('Unexpected runtime subprocess')
    process.stdout.write(JSON.stringify({ status: 'ok', result }))
  } catch (error) {
    const reason = error instanceof Error && 'data' in error ? error.data : { reason: 'transport-refused' }
    process.stdout.write(JSON.stringify({ status: 'rejected', data: reason }))
  } finally { await client.close() }
}
void main().catch(() => { process.exitCode = 1 })
