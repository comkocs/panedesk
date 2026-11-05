/**
 * `SandboxedFileSystem`: the sandbox-enforcing implementation of the
 * `@panedesk/dsh-fs` Service Definition. It extends `LocalFileSystem` so all
 * text-storage mechanics — resolve, stat, read/stream, list, the atomic
 * write and the read-match-write edit critical section — are the local
 * implementation's; this package adds per-call policy checks for mutations
 * and owner identity material reads. Full-access delegates without these checks.
 *
 * Content authorization checks the opened file's final name and identity;
 * all bytes come from that same handle, including edit and overwrite pre-reads.
 * Mutation containment remains path-based; its residual resolve-to-write race
 * is separate from descriptor-bound read authorization. Process isolation
 * remains the shell provider's responsibility.
 *
 * Per-call policy: `read-only` denies every mutation; `workspace-write` allows
 * a mutation only when the target canonicalizes under the policy's workspace
 * root or a platform temp area from the shared `writableRoots` policy;
 * `danger-full-access` delegates unfenced. A denial throws the structured
 * `FS_SANDBOX_DENIED`.
 *
 * @module @panedesk/dsh-fs-sandbox
 */

import { Context } from '@panedesk/cordis'
import { LocalFileSystem } from '@panedesk/dsh-fs-local'
import type { Config as LocalConfig, ReadIdentity } from '@panedesk/dsh-fs-local'
import { FsError } from '@panedesk/dsh-fs'
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@panedesk/dsh-fs'
import { canonicalPath, isOwnerMaterial, OWNER_MATERIAL_DENIED, writableRoots } from '@panedesk/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@panedesk/dsh-sandbox'
import type {} from '@panedesk/dsh-sandbox-policy'
import { isPathUnder } from './containment.ts'

/**
 * Plugin config: the local backend's knobs verbatim (`cwd` resolution default
 * and `diffBasisMaxBytes` overwrite-presentation bound). The sandbox default
 * (mode + `workspace-write` fallback root) is NOT here — `ctx.sandboxPolicy`
 * resolves each calling session for every enforcing capability.
 */
export type Config = LocalConfig

/**
 * Sandbox-enforcing filesystem backend. Registers as `ctx.fs` (loading it
 * INSTEAD OF `dsh-fs-local`, together with a `ctx.sandboxPolicy`, is the whole
 * swap — the model-facing tools are untouched). Its configured default mode is
 * the capability fact exposed by {@link sandboxMode}; `dsh-tool-fs` resolves
 * each session's mode and cwd into a policy for every mutation, while an
 * approved escalation may stamp a strictly wider mode for one call.
 */
export class SandboxedFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy']

  private readonly defaultMode: SandboxMode
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.defaultMode = ctx.sandboxPolicy.defaultMode
  }

  private readPolicy(policy?: SandboxExecutionPolicy) {
    const effective = policy ?? this.ctx.sandboxPolicy.resolve()
    if (effective.mode === 'danger-full-access') return effective as SandboxExecutionPolicy & { mode: 'danger-full-access' }
    return {
      ...effective,
      mode: effective.mode,
      unreadablePaths: [...new Set([
        ...effective.unreadablePaths ?? [],
        ...this.ctx.sandboxPolicy.resolve({ mode: effective.mode }).unreadablePaths ?? [],
      ])],
    }
  }

  protected override readAuthorization(policy?: SandboxExecutionPolicy) {
    const effective = this.readPolicy(policy)
    if (effective.mode === 'danger-full-access') return undefined
    return (identity: ReadIdentity): void => {
      if (isOwnerMaterial(identity.path, effective.unreadablePaths, identity)) {
        throw new FsError(OWNER_MATERIAL_DENIED, 'FS_SANDBOX_DENIED')
      }
    }
  }

  private async readableTarget(
    target: FsTarget, policy: ReturnType<SandboxedFileSystem['readPolicy']>,
  ): Promise<FsTarget> {
    if (policy.mode === 'danger-full-access') return target
    const fresh = await this.resolve(target.displayPath)
    if (isOwnerMaterial(this.processPath(fresh), policy.unreadablePaths)) {
      throw new FsError(OWNER_MATERIAL_DENIED, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }

  /** @param sandboxPolicy - Per-call read policy; omission uses the provider default. */
  override async stat(target: FsTarget, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy) {
    return super.stat(await this.readableTarget(target, this.readPolicy(sandboxPolicy)), signal)
  }

  /** @param sandboxPolicy - Per-call read policy; omission uses the provider default. */
  override async readText(target: FsTarget, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<string> {
    return super.readText(await this.readableTarget(target, this.readPolicy(sandboxPolicy)), signal, sandboxPolicy)
  }

  /** @param sandboxPolicy - Per-call read policy; omission uses the provider default. */
  override async streamText(
    target: FsTarget, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<AsyncIterable<string>> {
    return super.streamText(await this.readableTarget(target, this.readPolicy(sandboxPolicy)), signal, sandboxPolicy)
  }

  /** @param sandboxPolicy - Per-call read policy; omission uses the provider default. */
  override async readBytes(
    target: FsTarget, signal: AbortSignal | undefined, maxBytes: number, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<Uint8Array> {
    return super.readBytes(await this.readableTarget(target, this.readPolicy(sandboxPolicy)), signal, maxBytes, sandboxPolicy)
  }

  /** @param sandboxPolicy - Per-call read policy; omission uses the provider default. */
  override async readByteRange(
    target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<Uint8Array> {
    return super.readByteRange(await this.readableTarget(target, this.readPolicy(sandboxPolicy)), range, signal, sandboxPolicy)
  }

  /** @param sandboxPolicy - Per-call read policy; omission uses the provider default. */
  override async listDir(target: FsTarget, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy) {
    const policy = this.readPolicy(sandboxPolicy)
    const entries = await super.listDir(await this.readableTarget(target, policy), signal)
    if (policy.mode === 'danger-full-access') return entries
    return entries.filter(entry => !isOwnerMaterial(this.processPath(entry.target), policy.unreadablePaths))
  }

  /** The deployment default mode — the capability fact the tool layer reads to advertise escalation. */
  override get sandboxMode(): SandboxMode {
    return this.defaultMode
  }

  /**
   * Fence the write by the per-call policy, then delegate to the inherited
   * atomic write. See {@link checkedTarget}.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the write outcome from the inherited backend.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal, sandboxPolicy)
  }

  /**
   * Fence the edit by the per-call policy, then delegate to the inherited
   * atomic edit. See {@link checkedTarget}.
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the edit outcome from the inherited backend.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal, sandboxPolicy)
  }

  /**
   * Enforce the per-call policy against `target` and return the EXACT target the
   * mutation must use, so the checked identity is the mutated one (no
   * check-here-write-there TOCTOU). `read-only` denies; `workspace-write`
   * re-canonicalizes NOW (`resolve` realpaths the deepest existing ancestor,
   * reflecting a concurrently swapped symlink), requires containment under a
   * writable root, and returns THAT fresh target; `danger-full-access` returns
   * the caller's target unfenced. Throws the structured `FS_SANDBOX_DENIED` on
   * refusal — the tool layer maps it to the model-facing `[sandbox: …]` marker
   * and the escalation hint.
   */
  private async checkedTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return target
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    // workspace-write: containment on the FRESH canonical path (catches a
    // symlink ancestor swapped since the tool resolved this target), and the
    // mutation delegates with THIS fresh target — never the stale one.
    const fresh = await this.readableTarget(target, this.readPolicy(policy))
    const protectedPaths = new Set([
      ...policy.protectedPaths ?? [], ...this.ctx.sandboxPolicy.resolve().protectedPaths ?? [],
    ].map(canonicalPath))
    for (const root of protectedPaths) {
      if (await isPathUnder(fresh.targetKey, root) || await isPathUnder(root, fresh.targetKey)) {
        throw new FsError(`cannot write "${target.displayPath}": protected host path ${JSON.stringify(root)}`, 'FS_SANDBOX_DENIED', {
          sandboxDenial: 'protected-host-path',
        })
      }
    }
    let contained = false
    for (const root of writableRoots(policy)) {
      if (await isPathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained) {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }
}

export default SandboxedFileSystem
