---
description: "Opt-in project items, activity references, and immutable decision revisions in SQLite."
kind: "package-reference"
---

# @panedesk/dsh-trace-store

English | [中文](README.zh.md)

## Summary

The Web/Desktop Host mounts `traceStore`; recording and strict decisions default to off. `enable` grants project recording once, without per-entry confirmations. The service owns `<home>/projects/<projectId>/trace.sqlite`, using the existing home-path resolver, SQLite WAL, and one Host write queue. Each item, comment, assignment, setting update, or decision revision commits with its event in a short transaction.

## Use this package

The default export is the Host service. `/types` exports client-safe records, `/typert` supplies Host descriptors, and `/remote` exposes the same method names through the application Remote assembly. Workspace requests use `workspaceId`; optional `sessionId` identifies a user's window but does not grant model authority. Model callers use the current Host agent initiator for automatic session/model attribution.

- Workspace: `status`, `enable`, `disable`, `associateProject`, `setStrict`.
- Items: `createItem`, `closeItem`, `voidItem`, `listItems`.
- Activity: `timeline`, `assignEvents`, `comment`, `linkSession`, `readReference`.
- Decisions: `writeDecision`, `confirmDecision`, `rejectDecision`, `revertDecision`, `listDecisions`, `decisionHistory`.

The global `project_traces` domain maps canonical workspace paths to stable project identities and workspace switches. Explicit association reuses a registered project without scanning directories. `timeline` selects an item or null for unassigned activity, with an exclusive event cursor and a default page size of 100. `linkSession` assigns subsequent activity from that session and its descendants. Disabling recording retains data but disables strict mode; data operations require recording to be enabled.

Ordinary decision writes become active immediately. Strict mode names a non-subagent planning session: only its trusted Host agent may propose or propose a reversion, the user may revert directly, and only the user may confirm or reject the exact pending revision. A user-supplied window id is not planning authority. Revisions are append-only; confirmation and rejection append new revisions, while the active pointer changes only on activation or reversion. Switching recording, association, or strict mode also requires the user.

Observers record session and child-run lifecycle edges, turn/message sequence references, message delivery state, presented attachments, and ready workspace-change summaries. Deterministic session/sequence, subagent-run, and message-version keys suppress duplicate facts. Conversation and child output remain in SessionPersistence; explicit reference reads fetch only the selected slice. Attachment references retain declared paths rather than copying files. Change comparisons are synced to project-owned JSON files before their references commit, and before recorder cleanup.

Verification storage registers its original settings source. The first successful migration copies its JSON unchanged into project `settings`; failure leaves original workspace storage active. Recording-off workspaces keep using the original adapter. The project settings copy survives opt-out and is reused after re-enabling; settings are not model-writable.

## Model Experience

### Project recording

#### What the model sees

No new tools or prompt text. Host consumers can use the service operations; this package does not expose a model tool or CLI.

#### Token effect

Recording adds no model requests or conversation copies. Explicit downstream reads determine their own output budget.

#### KV Cache effect

Recording alone does not alter model input or cache reuse.

## Known Limitations and Deferred Work

Collection starts when recording is enabled; it does not backfill earlier sessions or scan other projects. Workspace-change coverage and byte/file limits remain those of the existing recorder. Binary and oversized comparisons retain their refusal metadata, not text diffs; unavailable file hashes remain null. A crash before reference commit can leave an unreferenced diff file. Independent Host processes do not share the in-process writer queue. Model tools, a read-only CLI, and user interface are separate consumers.

## Dev Note

`database.ts` owns monotonic schema version 1 and the relational tables; `session_links` is an additional indexed relation for descendant attribution. `registry.ts` owns workspace mapping. `capture.ts` waits for durable comparison writes; the existing changed-files card is unchanged. No Session format version or Core protocol number changes.
