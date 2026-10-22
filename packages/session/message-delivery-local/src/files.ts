/** Owner-only, checksummed mailbox files; unpublished temporary files are never replayed. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/** Storage failures stop dependent delivery rather than acknowledging uncertain writes. */
export class MailboxUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MailboxUnavailableError'
  }
}

/** Reject path separators, traversal, and platform-special names at the file boundary.
 * @param value - opaque identity used as one path component.
 * @returns the validated component.
 */
export function component(value: string): string {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,199}$/.test(value) || value.endsWith('.')
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) {
    throw new MailboxUnavailableError('Invalid mailbox path component')
  }
  return value
}

/** Check a private product subtree without following links.
 * @param root - existing private product home or new private root.
 * @param path - descendant directory to create and validate.
 */
export async function privateDirectory(root: string, path = root): Promise<void> {
  const base = resolve(root)
  const target = resolve(path)
  if (target !== base && !target.startsWith(base + sep)) throw new MailboxUnavailableError('Mailbox path escapes home')
  // Ancestors need not be private, but a linked ancestor must not redirect the product home.
  const ancestors: string[] = []
  for (let cursor = base; dirname(cursor) !== cursor; cursor = dirname(cursor)) ancestors.unshift(cursor)
  for (const ancestor of ancestors) {
    try {
      const stat = await lstat(ancestor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MailboxUnavailableError('Mailbox ancestor is not a real directory')
    } catch (error) {
      if (!isMissing(error)) throw error
      try { await mkdir(ancestor, { mode: 0o700 }) } catch (creationError) {
        if (!isExists(creationError)) throw creationError
      }
      const created = await lstat(ancestor)
      if (!created.isDirectory() || created.isSymbolicLink()) throw new MailboxUnavailableError('Mailbox ancestor is not a real directory')
    }
  }
  const paths = [base]
  if (target !== base) {
    let cursor = base
    for (const part of target.slice(base.length + 1).split(sep)) {
      cursor = join(cursor, component(part))
      paths.push(cursor)
    }
  }
  for (const directory of paths) {
    try { await mkdir(directory, { mode: 0o700 }) } catch (error) {
      if (!isExists(error)) throw error
    }
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) {
      throw new MailboxUnavailableError('Mailbox directory permissions are not private')
    }
  }
}

/** Check one already-open file, including its owner and link count. */
async function checkFile(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  const stat = await handle.stat()
  if (!stat.isFile() || stat.nlink !== 1
    || (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) {
    throw new MailboxUnavailableError('Mailbox file permissions are not private')
  }
}

/** Synchronize a directory after publishing or removing a file.
 * @param path - validated private directory.
 */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

/** Publish a complete checksummed JSON value; caller holds its sequence or ownership lock.
 * @param path - validated destination under a private directory.
 * @param value - JSON-serializable durable fact.
 * @param maxBytes - complete encoded-file byte ceiling.
 */
export async function publish(path: string, value: unknown, maxBytes: number): Promise<void> {
  const payload = JSON.stringify(value)
  const bytes = Buffer.from(payload)
  const encoded = JSON.stringify({ version: 1, length: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), payload }) + '\n'
  if (Buffer.byteLength(encoded) > maxBytes) throw new MailboxUnavailableError('Mailbox record exceeds byte limit')
  const temporary = join(dirname(path), `.pending-${randomUUID()}`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let published = false
  try {
    await checkFile(handle)
    await handle.writeFile(encoded)
    await handle.sync()
    await handle.close()
    try {
      const destination = await lstat(path)
      if (!destination.isFile() || destination.isSymbolicLink()) throw new MailboxUnavailableError('Mailbox destination is not a real file')
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (process.platform === 'win32') {
      const { publishWindowsFile } = await import('./windows-storage.ts')
      publishWindowsFile(temporary, path)
    } else {
      await rename(temporary, path)
    }
    published = true
    await syncDirectory(dirname(path))
  } finally {
    await handle.close()
    if (!published) {
      try { await unlink(temporary) } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
  }
}

/** Read and validate a complete file before domain decoding.
 * @param path - published mailbox file.
 * @param maxBytes - maximum complete encoded bytes.
 * @returns parsed JSON or undefined only when the file does not exist.
 */
export async function readValue(path: string, maxBytes: number): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  try {
    await checkFile(handle)
    const stat = await handle.stat()
    if (stat.size > maxBytes) throw new MailboxUnavailableError('Mailbox record exceeds byte limit')
    const bytes = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    if (length > maxBytes) throw new MailboxUnavailableError('Mailbox record exceeds byte limit')
    const envelope: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'))
    if (!object(envelope) || envelope.version !== 1 || typeof envelope.payload !== 'string'
      || envelope.length !== Buffer.byteLength(envelope.payload)
      || envelope.digest !== createHash('sha256').update(envelope.payload).digest('hex')) {
      throw new MailboxUnavailableError('Mailbox checksum or version mismatch')
    }
    const value: unknown = JSON.parse(envelope.payload)
    return value
  } finally { await handle.close() }
}

/** Enumerate published JSON files only; callers separately decode each record.
 * @param path - private record directory.
 * @returns lexically ordered file names, excluding incomplete temporary writes.
 */
export async function publishedFiles(path: string): Promise<string[]> {
  return (await readdir(path)).filter(name => name.endsWith('.json') && !name.startsWith('.')).sort()
}

/** Narrow decoded JSON objects.
 * @param value - decoded data.
 * @returns whether property inspection is safe.
 */
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Identify an absent filesystem entry without swallowing other failures.
 * @param error - caught filesystem failure.
 * @returns whether the entry is absent.
 */
export function isMissing(error: unknown): boolean {
  return object(error) && error.code === 'ENOENT'
}

/** Identify an existing filesystem entry.
 * @param error - caught filesystem failure.
 * @returns whether exclusive creation found an entry.
 */
export function isExists(error: unknown): boolean {
  return object(error) && error.code === 'EEXIST'
}
