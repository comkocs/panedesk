/** Real agents receive only credential paths and archive revokes their host binding. */
import { expect, test } from 'vitest'
import { mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import { ShellEnvRegistry } from '@panedesk/dsh-shell-env'
import type { ToolExecution } from '@panedesk/dsh-tools'
import { callHostSdk } from '@panedesk/dsh-host-admin'
import * as Admin from '@panedesk/dsh-host-admin'
import { SdkMethodRegistryProvider } from '@panedesk/dsh-sdk-jsonrpc-server'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { SessionId } from '@panedesk/dsh-session'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { engineFixture } from './engine-fixture.ts'
import { operation } from './fixtures.ts'
import { CreationAdapter } from './creation-provider.ts'
import { sessionCredentialSetup } from '../src/session-credentials.ts'
import { createCloseExecutor } from '../src/close-executor.ts'

const limits = { maxFrameBytes: 65536, requestTimeoutMs: 5000, maxPending: 8 }
test('publishes session paths through shell environment and revokes them on archive', async () => {
  const f = await engineFixture(true)
  try {
    f.ctx.llm.registerAdapter(['provider-a'], new CreationAdapter())
    const loop = await mountAgentLoopTestHarness(f.ctx)
    await f.open()
    const open = { ...f.created[0]!, sessionId: randomUUID() as SessionId }
    const agent = await loop.create(open.sessionId, { provider: 'provider-a', model: 'model-a' })
    f.ctx.sessionTitle.rename(agent.session, 'Binding test')
    const setup = sessionCredentialSetup(f.ctx)
    await setup(agent, open)
    expect(f.ctx.get('hostSessionCredentials')).toBeUndefined()
    Object.assign(f.ctx.loader.builtins, { admin: Admin, registry: SdkMethodRegistryProvider, env: ShellEnvRegistry })
    const endpointPath = join(f.options.directory, 'admin', 'endpoint.json')
    const profile = join(f.options.directory, 'credentials.yml')
    await writeFile(profile, JSON.stringify([{ name: 'cordis:env' }, { name: 'cordis:registry' }, { name: 'cordis:admin',
      config: { runtime: { ...limits, directory: join(f.options.directory, 'admin'), nodeId: 'node-a', principalId: 'operator',
        port: 0, maxStoreBytes: 1048576, maxOperations: 100 } } }]))
    await f.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
    await f.ctx.loader.await()
    await expect.poll(() => f.ctx.get('hostSessionCredentials')).toBeDefined()
    await expect.poll(() => f.ctx.get('shellEnv')?.list().length).toBe(2)
    f.ctx.get('sdkMethods')!.register({ namespace: 'example', version: '1', authorize: async () => ({ status: 'allowed' }),
      methods: { read: { decodeRequest: () => ({}), encodeResult: (value: string) => value,
        invoke: async (_params, identity) => identity.sessionId ?? 'unbound' } } })
    await setup(agent, open)
    const execution: ToolExecution = { agent, name: 'bash', arguments: {}, signal: new AbortController().signal,
      callId: 'call' as ToolExecution['callId'], rootCallId: 'call' as ToolExecution['rootCallId'],
      token: Symbol('tool-execution') as ToolExecution['token'] }
    const env = f.ctx.get('shellEnv')!.collect(execution)
    expect(env.DSH_HOST_ENDPOINT_PATH).toBe(endpointPath)
    const credentialPath = env.DSH_HOST_CREDENTIAL_PATH!
    expect(credentialPath).toMatch(/\/session-[^/]+\/credential$/)
    expect(await callHostSdk({ ...limits, endpointPath, credentialPath }, 'example/read', {}))
      .toEqual({ status: 'ok', value: agent.session.id })
    await createCloseExecutor(f.ctx, f.runtime, f.options).archive({ sessionId: open.sessionId, operationId: operation('close-binding') })
    await expect(callHostSdk({ ...limits, endpointPath, credentialPath }, 'example/read', {})).rejects.toThrow()
  } finally { await f.close() }
})
