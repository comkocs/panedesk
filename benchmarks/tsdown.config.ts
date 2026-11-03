import { defineConfig } from 'tsdown'

const shared = {
  format: 'esm' as const,
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  deps: {
    neverBundle: [/^@panedesk\//],
    onlyBundle: false as const,
  },
}

/** Compile measured benchmark workers while keeping workspace packages on their built `lib` entries. */
export default defineConfig([
  {
    ...shared,
    entry: { 'workspace-revocation.worker': 'workspace-revocation/workspace-revocation.worker.ts' },
    outDir: '.panedesk-build/workspace-revocation',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  {
    ...shared,
    entry: { 'protected-plugin-load.worker': 'protected-plugin-load/protected-plugin-load.worker.ts' },
    outDir: '.panedesk-build/protected-plugin-load',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  {
    ...shared,
    entry: { 'terminal-io.worker': 'terminal-io/terminal-io.worker.ts' },
    outDir: '.panedesk-build/terminal-io',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  {
    ...shared,
    entry: { 'reconnect.worker': 'active-stream-reconnect/reconnect.worker.client.ts' },
    outDir: '.panedesk-build/active-stream-reconnect',
    clean: true,
    tsconfig: 'tsconfig.client.json',
  },
  {
    ...shared,
    entry: {
      'agent-continuation.worker': 'agent-continuation/agent-continuation.worker.ts',
      'child-catalog.worker': 'agent-continuation/child-catalog.worker.ts',
      'profile-continuation.worker': 'agent-continuation/profile-continuation.worker.ts',
      'profile-adapter': 'agent-continuation/profile-adapter.ts',
    },
    outDir: '.panedesk-build/agent-continuation',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  {
    ...shared,
    entry: { 'session-open.worker': 'session-open/session-open.worker.ts' },
    outDir: '.panedesk-build/session-open',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  {
    ...shared,
    entry: {
      'session-corpus.worker': 'session-corpus/session-corpus.worker.ts',
      'projection-list.worker': 'session-corpus/projection-list.worker.ts',
    },
    outDir: '.panedesk-build/session-corpus',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  {
    ...shared,
    entry: {
      'conversation-fold.worker': 'conversation-fold/conversation-fold.worker.client.ts',
    },
    outDir: '.panedesk-build/conversation-fold',
    clean: true,
    tsconfig: 'tsconfig.client.json',
  },
  {
    ...shared,
    entry: { 'user-text.worker': 'user-text/user-text.worker.client.ts' },
    outDir: '.panedesk-build/user-text',
    clean: true,
    tsconfig: 'tsconfig.client.json',
  },
])
