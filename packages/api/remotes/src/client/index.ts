/** Platform-neutral assembly of generated Host Remote contributions. */

import type { Context } from '@panedesk/cordis'
import productAnalyticsRemote from '@panedesk/dsh-client-product-analytics/remote'
export type {} from '@panedesk/dsh-client-product-analytics/remote'
import agentPresetsRemote from '@panedesk/dsh-agent-preset-registry/remote'
import userQuestionsRemote from '@panedesk/dsh-user-questions/remote'
import commandsRemote from '@panedesk/dsh-commands/remote'
import accountRemote from '@panedesk/dsh-api-account-controller/remote'
import settingsControllerRemote from '@panedesk/dsh-api-settings-controller/remote'
import officeToPdfRemote from '@panedesk/dsh-office-to-pdf/remote'
import goalsRemote from '@panedesk/dsh-goal/remote'
import traceStoreRemote from '@panedesk/dsh-trace-store/remote'
export type {} from '@panedesk/dsh-trace-store/remote'
export type * from '@panedesk/dsh-trace-store/types'
import scheduleRemote from '@panedesk/dsh-schedule/remote'
import llmRemote from '@panedesk/dsh-llm/remote'
import cacheViewRemote from '@panedesk/dsh-llm-cache/remote'
export type {} from '@panedesk/dsh-llm-cache/remote'
import dynamicRemote from '@panedesk/dsh-cordis-host-runner/remote'
import pluginManagerRemote from '@panedesk/dsh-plugin-manager/remote'
import pluginRegistryProbeRemote from '@panedesk/dsh-client-ui-plugin-manager/remote'
import pluginMarketRemote from '@panedesk/dsh-plugin-market/remote'
import pluginInventoryRemote from '@panedesk/dsh-host-plugin-inventory/remote'
import bashSetupRemote from '@panedesk/dsh-host-bash-setup/remote'
import messageFeedbackRemote from '@panedesk/dsh-message-feedback/remote'
import permissionPresetsRemote from '@panedesk/dsh-permission-presets/remote'
import sessionFeedbackRemote from '@panedesk/dsh-command-feedback/remote'
import fileUploadsRemote from '@panedesk/dsh-client-file-upload/remote'
import sessionReferencesRemote from '@panedesk/dsh-session-reference/remote'
import subagentsRemote from '@panedesk/dsh-subagent/remote'
import sessionRemote from '@panedesk/dsh-api-session-controller/remote'
import jobRemote from '@panedesk/dsh-api-job-controller/remote'
import workspaceRemote from '@panedesk/dsh-api-workspace-controller/remote'
import terminalRemote from '@panedesk/dsh-api-terminal-controller/remote'
import workspaceFilesRemote from '@panedesk/dsh-api-workspace-files/remote'
import type { ClientRemote } from '@panedesk/dsh-api-gateway/client'

export type { ClientRemote } from '@panedesk/dsh-api-gateway/client'
export type {
  BundleInfo, BundleRowInfo, ChangeResult, IncompatiblePlugin, InspectOptions, InstallBundleOptions, InstallSpecKind, ManagementError,
  PackageResult,
  PluginChange, PluginEntryId, PluginInfo, PluginInspectProblem, PluginInstallCancellation, PluginInstallFailureKind,
  PluginInstallLogChunk, PluginInstallProgress, PluginInstallRequestId, PluginRegistries, PluginSpecInspection,
  ReadOnlyReason, Registry, RestartReason,
} from '@panedesk/dsh-plugin-manager/types'
export type {} from '@panedesk/dsh-plugin-manager/remote'
export type {} from '@panedesk/dsh-client-ui-plugin-manager/remote'
export type {} from '@panedesk/dsh-plugin-market/remote'
export type {
  MarketCompatibility, MarketIndexSummary, MarketInstallation, MarketInstallationStatus, MarketListingEntry, MarketListingVersion,
  MarketQuery, MarketSearchResult, MarketSort,
} from '@panedesk/dsh-plugin-market/types'
export type { PluginInventorySnapshot } from '@panedesk/dsh-host-plugin-inventory/types'
export type { BashSetupStatus, BashSetupWriteResult } from '@panedesk/dsh-host-bash-setup/types'
export type {} from '@panedesk/dsh-host-bash-setup/remote'
export type {} from '@panedesk/dsh-agent-preset-registry/remote'
export type {} from '@panedesk/dsh-user-questions/remote'
export type {} from '@panedesk/dsh-commands/remote'
export type {} from '@panedesk/dsh-api-settings-controller/remote'
export type {} from '@panedesk/dsh-api-account-controller/remote'
export type {} from '@panedesk/dsh-goal/remote'
export type {} from '@panedesk/dsh-schedule/remote'
export type {} from '@panedesk/dsh-office-to-pdf/remote'
export type {} from '@panedesk/dsh-llm/remote'
export type {} from '@panedesk/dsh-host-plugin-inventory/remote'
export type {} from '@panedesk/dsh-message-feedback/remote'
export type {} from '@panedesk/dsh-permission-presets/remote'
export type {} from '@panedesk/dsh-command-feedback/remote'
export type {} from '@panedesk/dsh-client-file-upload/remote'
export type {} from '@panedesk/dsh-session-reference/remote'
export type {} from '@panedesk/dsh-subagent/remote'
export type * from '@panedesk/dsh-subagent/client'
export type {} from '@panedesk/dsh-api-session-controller/remote'
export type * from '@panedesk/dsh-api-session-controller/types'
export type {} from '@panedesk/dsh-api-job-controller/remote'
export type * from '@panedesk/dsh-api-job-controller/types'
export type {} from '@panedesk/dsh-api-workspace-controller/remote'
export type * from '@panedesk/dsh-api-workspace-controller/types'
export type {} from '@panedesk/dsh-api-workspace-files/remote'
export type * from '@panedesk/dsh-api-workspace-files/types'
export type {} from '@panedesk/dsh-api-terminal-controller/remote'
export type * from '@panedesk/dsh-api-terminal-controller/types'
// The forwarded-event allowlist's selection seat: without it in the consumer's
// compilation face `TypertRemoteEvent` is `never` and every `$on` call fails.
export type { ApiRemoteForwardedEvent } from '../types.ts'
// The owner packages' client-safe `./types` exports supply the `Events`
// signatures `$on` hands to a listener, so a consumer reads the very
// declaration the Host emits rather than a flattened restatement of it.
export type {} from '@panedesk/dsh-commands/types'
export type {} from '@panedesk/dsh-cordis-host-runner/types'
export type {} from '@panedesk/dsh-credentials/types'
export type {} from '@panedesk/dsh-llm/types'
export type {} from '@panedesk/dsh-agent-preset-registry/types'
export type {} from '@panedesk/dsh-permission-presets/types'
export type {} from '@panedesk/dsh-settings/types'
export type {} from '@panedesk/dsh-user-approval/types'
export type {} from '@panedesk/dsh-user-questions/types'
export type {} from '@panedesk/dsh-api-session-controller/types'

/**
 * The carrier's Client-facing types, re-exported so a business package names one
 * assembly package instead of both this facade and the Connection plugin. Type-only:
 * the carrier's runtime values stay behind their own module edge.
 */
export type {
  ConnectionHandle, ConnectionSinks, ContentBlock,
  MessageId,
  RpcId, RpcRequest, RpcResponse, RpcResult, SessionId,
  StreamChunk,
} from '@panedesk/dsh-client-connection/client'
export type {} from '@panedesk/dsh-api-gateway/client'
export type {} from '@panedesk/dsh-cordis-host-runner/remote'

// The payload vocabulary of the selected namespaces, re-exported so a Client
// contribution can name what it sends and receives without importing a Host
// package: this assembly is the one place both planes legitimately meet.
export type {
  ApprovalRequestId,
  CordisHalfState,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  CordisInspectMethodManifest,
  CordisInspectPlatform,
  CordisInspectProviderManifest,
  CordisInspectProviderView,
  CordisInspectQueryRequest,
  CordisInspectQueryResolution,
  CordisInspectQueryResolved,
  CordisInspectRequestId,
  CordisInspectResolveAck,
  CordisRunDiagnostic,
  CordisRunStatus,
  DynamicCordisClientSource,
  DynamicCordisHostHalfResult,
  DynamicCordisInventoryRow,
  DynamicCordisInvokeResult,
  DynamicCordisPackage,
  DynamicCordisRequestResolved,
  DynamicCordisResolveAck,
  DynamicCordisRetracted,
  DynamicCordisRunRequest,
  DynamicCordisRunResolution,
  DynamicCordisRunAttempt,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
  RequestRunOutcome,
} from '@panedesk/dsh-cordis-host-runner/types'
// Credential state vocabulary for the credentials namespace (values never ride it).
export type { CredentialInfo } from '@panedesk/dsh-credentials/types'
// Redacted namespace vocabulary for the settings namespace (secrets never ride
// it). It travels with its seam, whose `./types` the Client face already reads.
export type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
} from '@panedesk/dsh-settings/types'
// Provider registry and discovery vocabulary for the llm namespace.
export type {
  LlmConfigurableProvider, LlmDiscoveredModel,
  LlmModelDiscoveryRequest, LlmNativeAuth, LlmProviderInfo,
} from '@panedesk/dsh-llm/types'
// Reference-discovery result vocabulary for the fileReferences and
// sessionReferenceResolver namespaces.
export type { FileReferenceCandidate } from '@panedesk/dsh-file-reference/types'
export type { SessionReferenceMentionCandidate } from '@panedesk/dsh-session-reference/types'

// The Remote failure vocabulary, re-exported so business packages keep naming
// this assembly alone. Types only: a value export would make spec imports load
// this module's owner /remote artifacts; specs take RemoteError from
// dsh-client-test-runtime instead.
export type {
  RemoteErrorCode, RemoteErrorDetailsMap, RemoteFailure, RemoteResult,
} from '@panedesk/dsh-typert-protocol'
export type { RemoteHostFacts } from '@panedesk/dsh-api-gateway/client'

declare module '@panedesk/cordis' {
  interface Context {
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: ClientRemote
  }
}

/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [
      productAnalyticsRemote, agentPresetsRemote, commandsRemote, settingsControllerRemote, accountRemote,
      goalsRemote, traceStoreRemote, llmRemote, cacheViewRemote, dynamicRemote, scheduleRemote,
      pluginInventoryRemote, pluginManagerRemote, pluginMarketRemote, pluginRegistryProbeRemote,
      bashSetupRemote,
      messageFeedbackRemote, sessionFeedbackRemote,
      fileUploadsRemote, sessionReferencesRemote,
      permissionPresetsRemote, subagentsRemote, sessionRemote, jobRemote, workspaceRemote, workspaceFilesRemote, terminalRemote,
      officeToPdfRemote, userQuestionsRemote,
    ]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  // Unwound in reverse mount order, so a namespace never outlives one mounted
  // after it.
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}
