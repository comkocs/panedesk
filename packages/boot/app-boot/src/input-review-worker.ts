/** Only host-owned review operations execute here; a blocked synchronous read cannot block its supervisor. */
import { readFileSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { userInfo } from 'node:os'
import { assertWindowsStateTrusted } from '@panedesk/dsh-sandbox-windows-acl'
import { ProtectedInputIntegrity, type ProtectedInputChange } from './input-integrity.ts'

const parentSend = process.send?.bind(process)
// A rejected entry keeps its non-zero exit; parent disconnect still releases an idle child.
let rejected = false
process.on('disconnect', () => { process.exit(rejected ? 1 : 0) })

/** Run one review session and close IPC; the caller handles a rejected entry. */
async function main(): Promise<void> {
  if (parentSend === undefined) throw new Error('Protected input review requires an IPC parent')
  let reader: ProtectedInputIntegrity | undefined
  let cacheKey: string | undefined
  let identity: string | undefined
  for (;;) {
    const request = await new Promise<unknown>((resolve) => { process.once('message', resolve) })
    if (typeof request !== 'object' || request === null || !('kind' in request)
      || !('workspace' in request) || typeof request.workspace !== 'string'
      || !('home' in request) || typeof request.home !== 'string') throw new Error('Invalid protected input review request')
    const resident = 'resident' in request && request.resident === true
    const requestId = 'requestId' in request ? request.requestId : undefined
    if (resident && typeof requestId !== 'string') throw new Error('Invalid protected input review identifier')
    const send = (value: object, callback?: (error: Error | null) => void): void => {
      const message = { ...value, ...resident ? { requestId } : {} }
      if (callback === undefined) parentSend(message)
      else parentSend(message, callback)
    }
    const response = async (): Promise<object> => {
      const value = await new Promise<unknown>((resolve) => { process.once('message', resolve) })
      if (typeof value !== 'object' || value === null || resident && (!('requestId' in value) || value.requestId !== requestId)) {
        throw new Error('Invalid protected input host response')
      }
      return value
    }
    try {
      const configuration = join(request.home, 'windows-workspace-write', 'input-review.json')
      assertWindowsStateTrusted(configuration, request.workspace)
      let timeoutMs = 30_000
      try {
        const stat = lstatSync(configuration)
        for (let current = dirname(configuration); ; current = dirname(current)) {
          const ancestor = lstatSync(current)
          if (!ancestor.isDirectory() || ancestor.isSymbolicLink()
            || process.platform !== 'win32' && ((ancestor.mode & 0o022) !== 0 && (ancestor.mode & 0o1000) === 0)) {
            throw new Error('Protected input review configuration has unsafe storage ancestry')
          }
          if (current === resolve(request.home) || current === dirname(current)) break
        }
        if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== 'win32'
          && ((stat.mode & 0o022) !== 0 || stat.uid !== userInfo().uid)) {
          throw new Error('Protected input review configuration must be an owner-controlled regular file')
        }
        const value: unknown = JSON.parse(readFileSync(configuration, 'utf8'))
        if (typeof value !== 'object' || value === null || !('stallTimeoutMs' in value)
          || typeof value.stallTimeoutMs !== 'number' || !Number.isSafeInteger(value.stallTimeoutMs) || value.stallTimeoutMs <= 0) {
          throw new Error('Invalid protected input review stallTimeoutMs')
        }
        timeoutMs = value.stallTimeoutMs
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      send({ kind: 'configuration', timeoutMs })
      let completed = 0
      const total = request.kind === 'verify' ? -1 : 0
      const report = (value: { completed: number; total: number }): void => {
        completed = value.completed
        send({ kind: 'progress', ...value })
      }
      report({ completed, total })
      if (request.kind === 'open') {
        const opened = ProtectedInputIntegrity.openOwnerRecords(request.workspace, request.home, report)
        await new Promise<void>((resolve, reject) => {
          send({ kind: 'result', result: opened.exportReviewState() }, (error) => { if (error) reject(error); else resolve() })
        })
      } else if (request.kind === 'verify' && 'cacheKey' in request && typeof request.cacheKey === 'string') {
        const imported = 'state' in request
        if (imported) {
          reader = ProtectedInputIntegrity.fromReviewState(request.state)
          cacheKey = request.cacheKey
        } else if (reader === undefined || request.cacheKey !== cacheKey) {
          throw new Error('Protected input worker generation does not match')
        }
        if (!reader.ownsWorkspaceRecord(request.workspace, request.home)) {
          throw new Error('Protected input worker changed workspace')
        }
        const before = reader.reviewIdentity()
        let confirmation = 0
        const confirm = async (change: ProtectedInputChange): Promise<boolean> => {
          const reply = response()
          send({ kind: 'confirmation', change, confirmation: ++confirmation })
          const value = await reply
          if (!('kind' in value) || value.kind !== 'confirmation' || !('accepted' in value) || typeof value.accepted !== 'boolean'
            || !('confirmation' in value) || value.confirmation !== confirmation) {
            throw new Error('Invalid protected input confirmation')
          }
          return value.accepted
        }
        reader.setReviewCommit(async (state) => {
          const reply = response()
          send({ kind: 'commit', state })
          const value = await reply
          if ('kind' in value && value.kind === 'commit-refused' && 'message' in value && typeof value.message === 'string') {
            throw new Error(value.message)
          }
          if (!('kind' in value) || value.kind !== 'commit' || !('revision' in value)
            || value.revision !== undefined && typeof value.revision !== 'string') {
            throw new Error('Invalid protected input commit response')
          }
          return value.revision
        }, async (state) => {
          const reply = response()
          send({ kind: 'prepare', state })
          const value = await reply
          if (!('kind' in value) || value.kind !== 'prepared') throw new Error('Invalid protected input preparation response')
        })
        reader.setReviewProgress(() => { completed++; send({ kind: 'progress', completed, total }) })
        const accepted = await reader.verify({ blocked() {}, confirm })
        const after = reader.reviewIdentity()
        const full = imported || before !== after || identity !== undefined && identity !== after
        identity = after
        const result = { accepted, cacheKey, identity, ...full ? { state: reader.exportReviewState() } : {} }
        await new Promise<void>((resolve, reject) => {
          send({ kind: 'result', result }, (error) => { if (error) reject(error); else resolve() })
        })
      } else throw new Error('Invalid protected input review operation')
    } catch (error) {
      send({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      break
    }
    if (!resident) break
  }
  process.disconnect()
}

void main().catch(() => {
  rejected = true
  process.exit(1)
})
