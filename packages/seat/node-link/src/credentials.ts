/** Directional channel credentials are provisioned only through checked private files. */
import { randomBytes, randomUUID } from 'node:crypto'
import { object, identifier, parseJson, type PrivateFiles, type RpcAuthentication } from '@panedesk/dsh-host-admin'

/** Each peer accepts its current epoch and an explicitly bounded prior-epoch overlap. */
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
 * @param maxOverlapMs - Explicit maximum overlap; omission accepts only the current epoch.
 * @returns Secret held only in memory, with its bound identity and epoch.
 */
export async function loadCredential(files: PrivateFiles, direction: 'inbound' | 'outbound', source: string, target: string,
  maxOverlapMs = 0): Promise<ChannelCredential> {
  if (!Number.isSafeInteger(maxOverlapMs) || maxOverlapMs < 0) throw new Error('Channel overlap bound rejected')
  const text = await files.read(`${direction}.json`, 4096)
  if (text === null) throw new Error('Channel credential unavailable')
  const value = parseJson(text, 4096)
  if (!object(value) || value.sourceNodeId !== source || value.targetNodeId !== target || !identifier(value.epoch)
    || typeof value.credential !== 'string' || !/^[a-f0-9]{64}$/.test(value.credential)) throw new Error('Channel credential rejected')
  const previous: { epoch: string; credential: string; expiresAt: number }[] = []
  if (value.previous !== undefined) {
    if (!Array.isArray(value.previous) || value.previous.length > 1) throw new Error('Channel overlap rejected')
    for (const item of value.previous) {
      if (!object(item) || !identifier(item.epoch) || item.epoch === value.epoch
        || typeof item.credential !== 'string' || !/^[a-f0-9]{64}$/.test(item.credential)
        || !Number.isSafeInteger(item.expiresAt) || Number(item.expiresAt) < 0) throw new Error('Channel overlap rejected')
      if (Number(item.expiresAt) > Date.now()) {
        if (Number(item.expiresAt) - Date.now() > maxOverlapMs) throw new Error('Channel overlap exceeds configured bound')
        previous.push({ epoch: item.epoch, credential: item.credential, expiresAt: Number(item.expiresAt) })
      }
    }
  }
  return { sourceNodeId: source, targetNodeId: target, epoch: value.epoch, credential: value.credential, previous }
}
