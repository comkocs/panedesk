/** Explicit exceptions and Host packages for the published dependency policy. */

/** Packages treated as Client/Host packages without declaring `dsh.client`. */
const CLIENT_FACE_INCLUDE: readonly string[] = []

/** Packages exempted from automatic Client/Host treatment despite declaring `dsh.client`. */
const CLIENT_FACE_EXCLUDE: readonly string[] = [
  '@panedesk/dsh-api-session-controller',
  '@panedesk/dsh-api-workspace-controller',
]

/** Host-only packages whose peer relays are deliberately flattened. */
const HOST_DEPENDENCY_PACKAGES: readonly string[] = [
  '@panedesk/dsh-llm',
  '@panedesk/dsh-session',
]

/** Required Cordis services whose Host imports are type-only. */
const REQUIRED_SERVICE_PEERS = {
  '@panedesk/dsh-api-terminal-controller': ['@panedesk/dsh-subprocess'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** Development-only package relationships not represented by source imports. */
const CONFIGURATION_ONLY_DEV_DEPENDENCIES = {
  '@panedesk/dsh-client-locale': ['@panedesk/dsh-api-remotes'],
  '@panedesk/dsh-client-ui-conversation': [
    '@panedesk/dsh-api-remotes',
    '@panedesk/dsh-client-ui-workspace',
  ],
  '@panedesk/dsh-client-ui-model-selection': ['@panedesk/dsh-client-ui-input-trigger'],
  '@panedesk/dsh-client-ui-sidebar': ['@panedesk/dsh-client-ui-workspace'],
  '@panedesk/dsh-client-ui-subagent': ['@panedesk/dsh-client-ui-input-trigger'],
  '@panedesk/dsh-client-ui-theme': ['@panedesk/dsh-api-remotes'],
  '@panedesk/dsh-client-ui-tool': ['@panedesk/dsh-api-remotes'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** Workspace packages whose complete runtime surface is safe across duplicate installations. */
const DUPLICATE_SAFE_PACKAGES: readonly string[] = [
  '@panedesk/dsh-brand',
  '@panedesk/dsh-lazy-require',
  '@panedesk/dsh-typert-protocol',
  '@panedesk/dsh-util-code-language',
  '@panedesk/dsh-util-crypto',
  '@panedesk/dsh-util-values',
]

/**
 * Runtime exports whose values remain valid when npm installs another package copy.
 * New entries are forbidden by default. Automated agents must not add an
 * exception; every addition requires explicit human review and a dedicated,
 * prominent heading in the pull request description.
 */
const SAFE_HOST_DEPENDENCY_EXPORTS = {
  '@panedesk/dsh-client-connection': ['authAdmissionBody'],
  '@panedesk/dsh-credentials': ['credentialKey'],
  '@panedesk/dsh-deque': ['Deque'],
  '@panedesk/dsh-llm': ['callConfigEquals'],
  '@panedesk/dsh-session-format': ['sessionFormatLogFilename'],
  '@panedesk/dsh-timeout': ['MAX_TIMER_DELAY_MS'],
  '@panedesk/schemastery': ['default'],
} as const satisfies HostDependencyExports

/** Runtime exports that require every consumer to resolve the provider's shared peer instance. */
const PEER_REQUIRED_HOST_EXPORTS = {
  '@panedesk/dsh-host-admin': ['readNodeHealth', 'executeNodeOperator', 'decodeHostAdminRequest'],
  // `instanceof` checks need the translator's own class instance.
  '@panedesk/dsh-experimental-translator': ['TranslationError'],
  '@panedesk/dsh-scope': ['carrierKeyOf', 'createScope', 'scopeOf', 'scopeTarget'],
  '@panedesk/dsh-session': ['SESSION_FORMAT_VERSION'],
  '@panedesk/dsh-session-persistence': ['SessionPersistenceNotFoundError'],
} as const satisfies HostDependencyExports

/** Exact import specifier to reviewed runtime exports. */
type HostDependencyExports = Readonly<Record<string, readonly string[]>>

/** Complete configurable input to package dependency classification. */
export interface PackageDependencyPolicy {
  readonly clientFaceInclude: readonly string[]
  readonly clientFaceExclude: readonly string[]
  readonly hostPackages: readonly string[]
  readonly requiredServicePeers?: Readonly<Record<string, readonly string[]>>
  readonly configurationOnlyDevDependencies: Readonly<Record<string, readonly string[]>>
  readonly duplicateSafePackages?: readonly string[]
  readonly safeHostDependencyExports: HostDependencyExports
  readonly peerRequiredHostExports: HostDependencyExports
}

/** Repository dependency policy consumed by verification and benchmarking. */
export const PACKAGE_DEPENDENCY_POLICY: PackageDependencyPolicy = {
  clientFaceInclude: CLIENT_FACE_INCLUDE,
  clientFaceExclude: CLIENT_FACE_EXCLUDE,
  hostPackages: HOST_DEPENDENCY_PACKAGES,
  requiredServicePeers: REQUIRED_SERVICE_PEERS,
  configurationOnlyDevDependencies: CONFIGURATION_ONLY_DEV_DEPENDENCIES,
  duplicateSafePackages: DUPLICATE_SAFE_PACKAGES,
  safeHostDependencyExports: SAFE_HOST_DEPENDENCY_EXPORTS,
  peerRequiredHostExports: PEER_REQUIRED_HOST_EXPORTS,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a package manifest declares a dynamically loaded Client entry. */
export function hasClientDeclaration(dshField: unknown): boolean {
  return isRecord(dshField) && Object.hasOwn(dshField, 'client')
}
