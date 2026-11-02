# Agent Note: Protected plugin load benchmark

Status: implemented

English | [中文](2026-11-03-protected-plugin-load-benchmark.zh.md)

## Problem

Protected executable reads compare complete plugin trees before returning verified bytes. Repeating that work for every module can make startup slow even when each individual file is small. Package-local correctness tests do not bound the combined capture and loading cost.

## Decision

The [protected plugin benchmark](../../../../benchmarks/protected-plugin-load/README.md) measures production `ProtectedInputIntegrity` through its built package export in a fresh plain-Node child. A synthetic 47-file tree totals 204,279 bytes, matching the installed Cordis Loader package's measured file count and byte size, excluding its dependency directory. Fixture creation is outside both timing intervals. Capture includes durable record publication; the second interval includes 47 executable reads, each with the full tree digest. No metadata-only shortcut replaces hashing.

Each run records a single sample per interval, same-interval process CPU, and whole-child peak RSS before assertions. Absolute reference limits are 250 ms for capture and 2,500 ms for repeated reads; the shared calibration multiplies them by the CI time scale and variance headroom. These are conservative throughput limits, not measured arm64 medians or a per-module latency promise. An initial Linux sample measured 4.04 ms capture, 81.90 ms reads, and 77.61 MiB peak RSS. That sample is a local sanity check, not cross-platform calibration. Memory is reported without a threshold or time scaling.

## Alternatives considered

**Measure ambient plugin contents.** Reading an installation during every run makes the workload depend on local package versions and contents. Fixed synthetic bytes retain the observed scale without importing ambient data.

**Time a copied digest function.** A private algorithm copy would omit durable record handling and production invalidation checks. The worker instead calls the shipped implementation.

**Cache by metadata alone.** Avoiding digest reads would measure a different trust decision and could miss modified bytes. Behavior tests own identity changes, linked-root races, and approval refusal; the benchmark preserves complete content comparison.

## Consequences

The benchmark detects large throughput regressions across capture and repeated reads while retaining raw evidence for tighter future budgets. It excludes owner response time, module evaluation, network filesystems, dependency-graph depth, Worker startup, and adversarial concurrent writers. The flat tree models byte and file-count scale, not every filesystem topology. Correctness and race coverage remain in app-boot tests rather than being duplicated as timing assertions.
