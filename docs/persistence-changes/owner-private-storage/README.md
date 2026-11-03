---
description: "Credential document location and crash-resilient relocation."
kind: reference
---

# Owner credential storage relocation

English | [中文](README.zh.md)

## Scope

This is a storage-location record, not a Session type transition. The credential YAML format and credential keys remain unchanged; the adjacent schema describes relocation locations rather than claiming a changed Session schema. The default document moves from `$PANEDESK_HOME/.credentials.yaml` to `$PANEDESK_HOME/private/.credentials.yaml`. Custom paths retain their location and protect their entire parent directory.

## Recovery

Startup writes the successor atomically, verifies its bytes, synchronizes the file, and on POSIX synchronizes both the private directory and its entry in the home directory before removing the predecessor. It then synchronizes the home directory again. Matching copies resume safely; conflicting copies remain untouched and stop startup. Windows does not use POSIX directory synchronization. The interruption fixture restarts after each completed instrumented filesystem operation; it simulates process-owned lock removal and does not claim hardware power-loss testing.

## Compatibility

New confirmed browser sessions may require login again after a Host restart. An older release does not discover the relocated document automatically: configure the new path explicitly before downgrading. A custom credential directory overlapping the workspace or another required readable root prevents restricted execution; move the file into a dedicated private directory. Do not use full access merely to bypass this refusal. Service-hosted Web deployments must configure their confirmation policy before upgrading; see the [upgrade guide](../../upgrade-guide/v0.2.1-rc.2/owner-private-storage/guide.md).
