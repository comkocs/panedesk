/** Authenticated hello refusals preserve safe categories without exposing transport details. */
import { object } from '@panedesk/dsh-host-admin'
import { decodeSeatFailureCause } from '@panedesk/dsh-sdk-protocol'
import type { NodeWorkChainReasonCode, SeatFailureCause } from '@panedesk/dsh-seat'
import type { NodeLinkErrorCode } from './index.ts'
import { NODE_LINK_VERSION, NODE_LINK_ERROR_CODES } from './index.ts'
import type { ChainCapability } from './chain-types.ts'
import { decodeChainCapability } from './chain-codec.ts'

/** Runtime-owned hello hooks disappear before accepted work drains. */
export interface ChainHelloHooks {
  /** Read capability only after every receiving dependency and recovery barrier resolves.
   * @returns Current advertised capability, or absence while unavailable.
   */
  capability(): ChainCapability | undefined
  /** Retain only authenticated peer capabilities; disconnect clears them.
   * @param capability - Validated peer capability, absent for an old peer or disconnect.
   */
  observe(capability: ChainCapability | undefined): void
}

/** Produce only fixed safe classifications after channel authentication has succeeded.
 * @param nodeId - Local logical node identity.
 * @param nonce - Exact initiating hello nonce.
 * @param epoch - Actual authenticated credential epoch.
 * @param code - Existing transport failure category.
 * @param reasonCode - Frozen bounded diagnostic.
 * @returns Structured hello refusal, with no invented execution outcome.
 */
export function helloRefusal(nodeId: string, nonce: string, epoch: string, code: NodeLinkErrorCode,
  reasonCode: NodeWorkChainReasonCode): object {
  return { version: NODE_LINK_VERSION, nodeId, nonce, epoch, status: 'rejected', cause: {
    domain: 'node-link', code, reason: reasonCode, reasonCode, effectState: 'none', retryable: false,
    operationId: nonce, nodeId } }
}

/** Decode a refusal only after node, nonce and authenticated epoch have been correlated.
 * @param value - Authenticated hello response.
 * @returns Original safe cause, or absence for a successful hello.
 */
export function decodeHelloRefusal(value: unknown): SeatFailureCause | undefined {
  if (!object(value) || value.status !== 'rejected') return undefined
  const cause = decodeSeatFailureCause(value.cause)
  if (!Object.hasOwn(NODE_LINK_ERROR_CODES, cause.code) || cause.nodeId !== value.nodeId
    || cause.operationId !== value.nonce || cause.effectState !== 'none') throw new Error('Node hello cause rejected')
  return cause
}

/** Read an optional peer capability without changing an old peer's hello payload.
 * @param value - Authenticated successful hello.
 * @returns Strict optional chain capability.
 */
export function helloCapability(value: unknown): ChainCapability | undefined {
  return object(value) ? decodeChainCapability(value.chain) : undefined
}
