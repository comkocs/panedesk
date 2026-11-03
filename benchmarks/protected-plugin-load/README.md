# Protected plugin loading

English | [中文](README.zh.md)

This benchmark measures durable input capture followed by 47 verified module reads through `ProtectedInputIntegrity`. Its synthetic tree has 47 files and 204,279 bytes, matching the measured size of the installed Cordis Loader package without reading user material during measurement. Each module read computes the complete production tree digest; no metadata-only cache substitutes for content comparison.

The worker runs built app-boot under plain Node in a fresh private directory. Timings exclude fixture creation and include the capture's record write. Process CPU covers the same intervals; peak RSS covers the whole child process. Reference limits are 250 ms for capture and 2,500 ms for all reads before the shared CI time scale. These coarse limits detect throughput regressions, not a single-module latency promise. The scenario excludes owner interaction time, network filesystems, deeply nested dependency graphs, and adversarial concurrent writers; behavior tests own invalidation and refusal.

A second capture-only case synthesizes 44,494 distinct files totaling 703,177,774 bytes, observed through two linked roots. It retains the measured file/byte scale of an overlapping-root experiment, not its real plugin contents or dependency topology. Both roots are fully hashed; durable blobs may share identical bytes. Its reference capture limit is 30,000 ms before shared CI scaling; fixture creation is excluded, and memory is whole-child peak RSS. An earlier overlapping-root sample took 13,170.63 ms and ended at 463,220,736 RSS bytes; that endpoint was not a peak or a same-input application replay.

After building benchmark workers, run `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/protected-plugin-load/protected-plugin-load.bench.ts`. The shared reporter records timing and memory evidence before budget assertions. [The benchmark decision](../../.agents/notes/implemented/testing/2026-11-03-protected-plugin-load-benchmark.md) records calibration limits and excluded scenarios.
