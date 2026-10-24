/** Directional channel credentials are provisioned only through checked private files. */
import { randomBytes, randomUUID } from 'node:crypto'
import { object, identifier, parseJson, type PrivateFiles, type RpcAuthentication } from '@panedesk/dsh-host-admin'

/** Each peer accepts only its current epoch; changing it revokes prior credentials immediately. */
export interface ChannelCredential extends RpcAuthentication { sourceNodeId: string; targetNodeId: string }

/** Provision one inbound credential without displaying or returning its secret.
 * @param files - Checked destination directory.
 * @param sourceNodeId - Allowed sending node.
 * @param targetNodeId - Receiving node.
 * @returns Completion after owner-only durable publication.
 */
export async function provisionInbound(files: PrivateFiles, sourceNodeId: string, targetNodeId: string): Promise<void> {
  if (!identifier(sourceNodeId) || !identifier(targetNodeId) || sourceNodeId === targetNodeId) throw new Error('Channel identity rejected')
  await files.write('inbound.json', JSON.stringify({ sourceNodeId, targetNodeId,
    epoch: randomUUID(), credential: randomBytes(32).toString('hex') }))
}

/** Load an already provisioned directional credential; never derive it from SSH or browser auth.
 * @param files - Platform private-file implementation.
 * @param direction - Fixed local credential reference.
 * @param source - Expected sending alias.
 * @param target - Expected receiving alias.
 * @returns Secret held only in memory, with its bound identity and epoch.
 */
export async function loadCredential(files: PrivateFiles, direction: 'inbound' | 'outbound', source: string, target: string): Promise<ChannelCredential> {
  const text = await files.read(`${direction}.json`, 4096)
  if (text === null) throw new Error('Channel credential unavailable')
  const value = parseJson(text, 4096)
  if (!object(value) || value.sourceNodeId !== source || value.targetNodeId !== target || !identifier(value.epoch)
    || typeof value.credential !== 'string' || !/^[a-f0-9]{64}$/.test(value.credential)) throw new Error('Channel credential rejected')
  return { sourceNodeId: source, targetNodeId: target, epoch: value.epoch, credential: value.credential }
}
