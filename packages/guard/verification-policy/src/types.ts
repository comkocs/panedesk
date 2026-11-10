/** Browser-safe workspace verification settings and task-control requests. */
import type { WorkspaceId } from '@panedesk/dsh-workspace/types'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { ActivityCategory } from '@panedesk/dsh-activity-category/types'

/** One versioned workspace record; null numeric limits mean unlimited. */
export interface VerificationSettings {
  version: 1
  enabled: boolean
  fullTests: 'allow' | 'once' | 'deny'
  mutation: boolean
  scripts: boolean
  ci: boolean
  focusedTests: boolean
  clientMinutes: number | null
  budget: { minutes: number | null; percent: number | null; action: 'ask' | 'deny' }
}

/** Stable product preset ids. */
export type VerificationPreset = 'default' | 'unlimited' | 'build-only'

/** Current settings and product presets for the selected workspace. */
export interface VerificationView {
  settings: VerificationSettings
  presets: Record<VerificationPreset, VerificationSettings>
}

/** Workspace identity supplied by the workspace picker. */
export interface VerificationWorkspaceRequest { workspaceId: WorkspaceId }

/** Complete replacement, never a model-writable configuration patch. */
export interface VerificationSaveRequest extends VerificationWorkspaceRequest { settings: VerificationSettings }

/** An exact task identity prevents a stale tree row from changing the next run. */
export interface VerificationTaskRequest { sessionId: SessionId; taskId: string; prohibited: boolean }

/** Checklist consumers append these shared activity ids to one task's prohibitions. */
export interface VerificationTaskRestrictions { sessionId: SessionId; taskId: string; categories: readonly ActivityCategory[] }
