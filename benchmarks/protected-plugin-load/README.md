# Protected plugin loading

English | [中文](README.zh.md)

This benchmark measures durable input capture followed by 47 verified module reads through `ProtectedInputIntegrity`. Its synthetic tree has 47 files and 204,279 bytes, matching the measured size of the installed Cordis Loader package without reading user material during measurement. Each module read computes the complete production tree digest; no metadata-only cache substitutes for content comparison.

The worker runs built app-boot under plain Node in a fresh private directory. Timings exclude fixture creation and include the capture's record write. Process CPU covers the same intervals; peak RSS covers the whole child process. Reference limits are 250 ms for capture and 2,500 ms for all reads before the shared CI time scale. These coarse limits detect throughput regressions, not a single-module latency promise. The scenario excludes owner interaction time, network filesystems, deeply nested dependency graphs, and adversarial concurrent writers; behavior tests own invalidation and refusal.

After building benchmark workers, run `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/protected-plugin-load/protected-plugin-load.bench.ts`. The shared reporter records timing and memory evidence before budget assertions. [The benchmark decision](../../.agents/notes/implemented/testing/2026-11-03-protected-plugin-load-benchmark.md) records calibration limits and excluded scenarios.
