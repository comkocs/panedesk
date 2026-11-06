/** Only host-owned review operations execute here; a blocked synchronous read cannot block its supervisor. */
import { readFileSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { userInfo } from 'node:os'
import { assertWindowsStateTrusted } from '@panedesk/dsh-sandbox-windows-acl'
import { ProtectedInputIntegrity, type ProtectedInputChange } from './input-integrity.ts'

const send = process.send?.bind(process)
if (send === undefined) throw new Error('Protected input review requires an IPC parent')
const request = await new Promise<unknown>((resolve) => { process.once('message', resolve) })
if (typeof request !== 'object' || request === null || !('kind' in request)
  || !('workspace' in request) || typeof request.workspace !== 'string'
  || !('home' in request) || typeof request.home !== 'string') throw new Error('Invalid protected input review request')

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
  let total = request.kind === 'verify' ? -1 : 0
  const report = (value: { completed: number; total: number }): void => {
    completed = value.completed
    total = value.total
    send({ kind: 'progress', completed, total })
  }
  report({ completed, total })
  if (request.kind === 'open') {
    const reader = ProtectedInputIntegrity.openOwnerRecords(request.workspace, request.home, report)
    await new Promise<void>((resolve, reject) => {
      send({ kind: 'result', result: reader.exportReviewState() }, (error) => { if (error) reject(error); else resolve() })
    })
  } else if (request.kind === 'verify' && 'state' in request) {
    const reader = ProtectedInputIntegrity.fromReviewState(request.state)
    const confirm = (change: ProtectedInputChange): Promise<boolean> => new Promise((resolve, reject) => {
      process.once('message', (value: unknown) => {
        if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'confirmation'
          || !('accepted' in value) || typeof value.accepted !== 'boolean') reject(new Error('Invalid protected input confirmation'))
        else resolve(value.accepted)
      })
      send({ kind: 'confirmation', change })
    })
    reader.setReviewProgress(() => {
      completed++
      send({ kind: 'progress', completed, total })
    })
    const accepted = await reader.verify({ blocked() {}, confirm })
    await new Promise<void>((resolve, reject) => {
      send({ kind: 'result', result: { accepted, state: reader.exportReviewState() } }, (error) => { if (error) reject(error); else resolve() })
    })
  } else throw new Error('Invalid protected input review operation')
} catch (error) {
  send({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
} finally { process.disconnect() }
