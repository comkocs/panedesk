---
description: "Model tools for opt-in project recording through the existing trace service."
kind: "package-reference"
---

# @panedesk/dsh-tool-trace

English | [中文](README.zh.md)

## Use this package

The Web/Desktop composition registers six tools against the existing `traceStore` service. Each call resolves the current session's registered workspace, including durable parent-session ownership; it never accepts a workspace or caller identity from model arguments. Writes run under the trusted current Agent initiator so the service records session/model attribution and enforces strict decisions. Recording-off calls return a request to ask the user to enable recording in workspace settings. No operation enables recording, changes verification switches, confirms proposals, or executes arbitrary SQL.

`trace_items` lists, creates, and closes items; `trace_timeline` pages an item or unassigned activity; `trace_read_ref` reads the selected original excerpt or durable diff; `trace_comment` appends a comment; `trace_link_session` links only the current session; `trace_decision` reads active decisions/history or appends a revision. The tool schemas describe every parameter and conditional requirement. Results are JSON text, with `{ "ok": true }` for mutations without a returned record. Presentation uses the existing generic tool card.

Ordinary decision writes become active immediately. In strict mode, the designated planning session can only propose, while other sessions and subagents cannot write decisions; user confirmation remains outside these tools. Attachments retain recorded pointers instead of being read as arbitrary files.

Settings → Tools uses the existing registered-tool catalog and disabled-name preferences to hide individual tools in new ordinary sessions. That preference is presentation, not authorization; service checks still run at execution. Existing subagent tool policies remain unchanged.

## Model Experience

### Project recording

#### What the model sees

Six English-described tools and, only while its workspace records activity, one system-prompt section asking the model to link the session at the start of work and record decisions. The section uses the same assembly extension as verification policy and is persisted through normal prompt projection.

#### Token effect

Tool schemas and the enabled-project sentence consume context. Explicit reads determine returned trace content; automatic collection does not copy conversation text into prompts or make model calls.

#### KV Cache effect

The sentence is stable while recording stays enabled. Changing recording changes assembled prompt content; tool preferences follow the existing per-session snapshot behavior.

## Known Limitations and Deferred Work

This package does not add specialized client cards or change subagent tool allowlists. References use the trace service's existing read behavior and timeline page size defaults. Read-only command-line exports belong to the launcher package; user-facing item and decision panels are separate consumers.
