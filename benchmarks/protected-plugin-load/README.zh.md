# 受保护插件加载

[English](README.md) | 中文

此基准通过 `ProtectedInputIntegrity` 测量持久输入采集及后续 47 次已验证模块读取。合成树包含 47 个文件、204,279 字节，与已安装 Cordis Loader 包的实测规模相当，测量期间不读取用户材料。每次模块读取都计算完整的生产树摘要，不以仅含元数据的缓存替代内容比较。

工作进程在全新的私有目录中，以普通 Node 运行已构建的 app-boot。计时不含夹具创建，包含采集时的记录写入。进程 CPU 覆盖相同时段；峰值 RSS 覆盖整个子进程。应用共享 CI 时间缩放前，参考上限为采集 250 ms、全部读取 2,500 ms。这些粗粒度上限用于检测吞吐回退，不承诺单模块延迟。场景不包含 owner 交互时间、网络文件系统、深层依赖图及恶意并发写入；失效与拒绝由行为测试负责。

构建基准工作进程后，运行 `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/protected-plugin-load/protected-plugin-load.bench.ts`。共享报告器在预算断言之前记录时间与内存证据。[基准决策](../../.agents/notes/implemented/testing/2026-11-03-protected-plugin-load-benchmark.zh.md) 记录校准限制和排除的场景。
