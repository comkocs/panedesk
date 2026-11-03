---
description: "凭据文档位置与迁址兼容性。"
kind: reference
---

# 所有者凭据存储迁址

[English](relocation.md) | 中文

## 范围

此存储位置变更不改变 Session 类型、凭据 YAML 字段或凭据键。[位置 schema](relocation.schema.json) 描述默认旧位置和新位置，不代表 Session 格式迁移。

## 恢复

凭据提供方负责[迁址顺序与恢复](../README.zh.md)。Windows 不使用 POSIX 目录同步。

## 兼容性

浏览器重新认证、服务配置、自定义目录要求与显式降级路径参见[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.2/owner-private-storage/guide.zh.md)。
