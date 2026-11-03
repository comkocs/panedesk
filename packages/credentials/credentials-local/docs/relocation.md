---
description: "Credential document location and relocation compatibility."
kind: reference
---

# Owner credential storage relocation

English | [中文](relocation.zh.md)

## Scope

This storage-location change does not change Session types, credential YAML fields, or credential keys. The [location schema](relocation.schema.json) describes the default predecessor and successor, not a Session format transition.

## Recovery

The credential provider owns [relocation ordering and recovery](../README.md). Windows does not use POSIX directory synchronization.

## Compatibility

See the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/owner-private-storage/guide.md) for browser reauthentication, service configuration, custom-directory requirements, and explicit downgrade paths.
