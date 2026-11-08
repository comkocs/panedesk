/** Derived settings slot props with plain callbacks and a renderer-bound observation. */
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { ConnectionInput, ConnectionTest, DatabaseConnection } from '@panedesk/dsh-db-connections/types'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import type {} from './locales.ts'

export interface Inspection {
  loading: boolean
  filename: string
  connections: DatabaseConnection[]
  error: string
}
export interface KeyListing {
  path: string
  parent: string
  entries: { name: string; path: string; directory: boolean }[]
}
export interface Injected {
  hooks: { inspection: HostObservable<Inspection> }
  refresh(): Promise<void>
  save(input: ConnectionInput): Promise<void>
  remove(id: string): Promise<void>
  test(input: ConnectionInput): Promise<ConnectionTest>
  browse(path: string): Promise<KeyListing>
  open(path: string): Promise<void>
}
export type DatabaseProps = PropsRuntime<'settings.section'> & InjectFace<Injected> & PropsLocale<'databaseConnections'>
