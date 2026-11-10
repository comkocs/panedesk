---
description: "Per-workspace verification settings in the Panedesk settings group."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-settings-verification

English | [中文](README.zh.md)

## Summary

Adds Settings → Panedesk → Verification in the shared Web/Desktop composition. The settings shell supplies the three-line guidance header. The page selects a workspace, reads its verification policy, and saves a complete versioned record through the owner-only remote service.

## Use this package

Choose Default, Unlimited (statistics only), Build only, or Custom. Controls cover enablement, full-test allow/once/deny, mutation tests, self-written scripts, CI triggers, focused tests, client waiting minutes, and task verification budgets in minutes or percentage. Empty numeric fields mean unlimited. Save applies subsequent-call policy without changing project files or model-editable settings. The subagent tree opens this page through `settingsNavigation.openSection('verification')`.

The service owns preset values and enforcement. The UI shows read/save failures and keeps edits local until saving succeeds. Disabling verification leaves statistics active. Budget approval limitations and classification blind spots are visible on the page.

## Model Experience

### Workspace policy editing

#### What the model sees

This page adds no tools or model messages. The companion verification-policy service informs and constrains the model.

#### Token effect

None from this UI package; it makes no model calls.

#### KV Cache effect

None directly; saved policy changes affect the companion service's prompt line.

## Known Limitations and Deferred Work

The existing approval dialog only supports single-call permission or rejection, not the task-wide alternatives listed in the prompt. No live client launch or behavior test is implied by package compilation.

## Dev Note

Client service dependencies are declared explicitly; wire data uses the service's browser-safe type entry.
