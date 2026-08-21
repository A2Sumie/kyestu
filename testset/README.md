# kyestu 测试集

两层结构：

1. **parity 钉住层**（cases/10–80）：把旧系统（idol-bbq-utils，维护完成后状态）的隐性行为逐条钉成显式用例。每条 `anchor` 指向旧代码 file:line——上游变动时按锚点重新推导该条。
2. **cordis 符合性层**（cases/90–99）：钉新 runtime 自身的保证（生命周期、级联、故障、影子对比）。

## case schema

```yaml
- id: RG-01            # 域前缀-序号
  title: 一句话
  layer: unit|route|render|send|lifecycle|e2e
  anchor: 旧代码 file:line（parity 层必填）
  given: 前置（fixture/DB 种子/模式）
  when: 动作
  then: 预期（旧系统被钉住的行为 / 新系统的保证）
```

fixture 见 `fixtures/`：`config.min.yaml` 为最小配置（1 crawler / 1 processor / 2 formatter / 2 target），`articles/*.json` 为文章样本。所有预期值来自旧代码事实，不是想象。

## harness 约定（设计意图，实现状态见下节）

- **fake clock**：cron/tick/冷却/摘要窗全部时间相关，一律虚拟时钟驱动。
- **capture 接收端**：OneBot/B站 发送走 `IDOL_BBQ_OUTBOUND_SEND_MODE=capture` 到 JSONL，对比消息序列。
- **平台 fake**：X/IG/TT/YT 用录制 payload；oembed/probe 用本地 stub。
- **hermetic 渲染**：`RENDER_REMOTE_ASSETS=0` + 固定 FONTS_DIR。
- **影子运行**：独立 DB 副本 + 独立 CACHE_DIR；旧系统跑 live 或 capture，新系统跑 capture；发散点先查 SH-02 白名单。

## 执行状态（2026-08-21 实测，SA-7；禁止照抄旧文档数字）

### 用例总数与 tests/ 的关系

- testset 实际 **99 条 entry，99 个唯一 id**：parity 层 78 条（cases/10–80），符合性层 21 条（LC 11 + FI 6 + SH 4）。旧文档"82 条（71+21）"的说法已过时。
- 本次修复的历史遗留（全部因 harness 缺席、文件从未被机器解析而未暴露）：HC-07 撞号——2026-08-21 新增的冷却隔离用例（commit 7dd62ea）与 08-16 既有的内容新鲜度 TTL 用例同号，已将后者改号 **HC-08**（PITFALLS D4、HC-01 交叉引用与 `test:` 字段均指冷却隔离那条，保持 HC-07 不动）；另修复两处 YAML 语法错误（40-outbound-dedup.yaml `>2h` 未加引号被读成块标量头、80-processor.yaml 两处值内嵌套映射）。
- `bun test`（tests/，本批次基线 383 pass）是**独立生长的套件，不引用任何 testset 用例 id**；v1 报告（08-16）的"248 tests"是同一 bun 套件的当时快照。testset ↔ tests/ 之间唯一的机器链接是 HC-07 的 `test: tests/cooldown-isolation.test.ts` 字段。
- 结论：testset 目前主要是**规范层**；把它系统接到 bun test（逐条建立映射或造 harness）是一个独立项目，本批次不做。

### harness 实况

| 约定 | 状态 | 证据 |
|---|---|---|
| fake clock | **未实现** | tests/ 与 src/ 无 useFakeTimers/setSystemTime；调度类测试用真实短间隔等待 |
| capture JSONL（`IDOL_BBQ_OUTBOUND_SEND_MODE`） | **旧系统约定，kyestu 无此 env** | 全仓零命中；kyestu 的等价物是 `Bun.serve` OneBot mock + 内存捕获（tests/components.test.ts `withMockOneBot`、e2e.test.ts、shortcircuit.test.ts） |
| 平台 fake（录制 payload） | **部分** | 逐测试内联 mock，无共享 payload 库；fixtures/articles/*.json 仅为文章样本 |
| hermetic 渲染 | **已实现** | `RENDER_REMOTE_ASSETS=0` + `FONTS_DIR` 默认指向 assets/fonts（src/components/formatter.ts、src/pipeline/summary-card.ts；tests/summary-card.test.ts、shortcircuit.test.ts 使用） |
| 影子运行（独立 DB/CACHE_DIR） | **未实现** | 无影子基础设施；且需旧系统并行部署，SH-01..04 全部 blocked |

### 符合性层 21 条逐条状态

| id | 状态 | 证据 / 缺口 |
|---|---|---|
| LC-01 资源探针归零 | blocked-on-harness | 无定时器/listener/page/子进程探针实现 |
| LC-02 effect PBT | blocked-on-harness | 无 PBT harness；effect.test.ts 仅定点用例 |
| LC-03 单 entry 变更只重载该 fiber | **executable-covered** | tests/lifecycle.test.ts（per-entry reconciliation）、tests/loader.test.ts（with 变更只重建该 fiber） |
| LC-04 逆失败容错+污点 | **executable-covered** | tests/effect.test.ts（inverse throwing is tainted, not fatal） |
| LC-05 guard 超时强卸+标记 | **executable-covered** | tests/lifecycle.test.ts（guard timeout … with taint recorded） |
| LC-06 teardown 不丢持久化摘要队列 | **executable-covered** | tests/persistence-b.test.ts（digest 缓冲跨 db reopen/fiber 重建存活并恰好 flush 一次） |
| LC-07 发送槽 teardown 释放 | partial | 出站 claim 回收（tests/v11.test.ts）与 browser-pool 驱逐（tests/components.test.ts）各自有钉；"发送中途 unload 后无残留 claim"的组合未钉 |
| LC-08 ghost write 防护 | **executable-covered** | tests/lifecycle.test.ts（ghost write guard） |
| LC-09 汇合性抽测 | partial | tests/confluence.test.ts 钉两条确定性性质；≥100 步随机序列抽测未实现 |
| LC-10 broker 吸收 provider 切换 | partial | broker 并非独立 fiber——fallback 在 processor/openai 组件内（llm-openai.ts），"消费方不 reload"平凡成立；熔断→fallback→回切已由 components.test.ts + persistence-b.test.ts（llm-circuit）钉住 |
| LC-11 健康 coeffect 静态检查 | **obsolete** | 健康 coeffect 模型已放弃（冷却/熔断落 pipeline + service_state）；静态图检查不存在 |
| FI-01 NapCat 断开/恢复自动停复 | partial | onebot retcode 映射有钉（components.test.ts）；deactivate→recover 双周期 e2e 未钉 |
| FI-02 群禁言抑制 | partial | 同上；禁言场景与"不攒 failed 行"未专项钉 |
| FI-03 浏览器崩溃只影响本 crawler | partial | pool disconnect→evict→relaunch 有钉（components.test.ts）；"其他 crawler 无感"未钉 |
| FI-04 LLM 熔断→fallback→回切 | **executable-covered** | tests/components.test.ts（circuit/fallback）、tests/persistence-b.test.ts（breaker 持久化、fiber 重建保持） |
| FI-05 DB 不可用优雅降级 | blocked-on-harness | 需 SQLite 锁/只读故障注入，无实现 |
| FI-06 reconcile 中途失败不影响其他 fiber | **executable-covered** | tests/lifecycle.test.ts（apply failure siblings unaffected）、tests/loader.test.ts（FAILED 不自动复活、force 复位） |
| SH-01 7 天流量重放对比 | blocked-on-harness | 无录制流量、无影子 DB、需旧系统并行 |
| SH-02 发散白名单 | blocked-on-harness | 依赖 SH-01 |
| SH-03 id 迁移映射验证 | blocked-on-harness | 需生产 DB 副本；tests/import.test.ts 只测合成配置 |
| SH-04 逐路由切流验收 | blocked-on-harness | 运维流程，需并行部署期 |

汇总：**executable-covered 7 / partial 6 / blocked-on-harness 7 / obsolete 1**。标 covered 的条目由全量 `bun test` 实际执行（本批次验证 383 pass/0 fail）；partial 条目语义核心有钉但用例的完整形状未钉。

### parity 层 78 条状态

**作为整体 spec-only**：anchor 指向旧系统 file:line，未建立到 bun test 的逐条映射（唯一例外 HC-07）。个别行为在 tests/ 有等价钉住（如冷却持久化 service-state.test.ts、出站幂等 v11.test.ts），但未逐条核验，不声称覆盖。

## 覆盖图

| 文件 | 域 | 对应 PITFALLS |
|---|---|---|
| cases/10-config-route.yaml | 配置编译/路由图 | A, J7, J9 |
| cases/20-render.yaml | 渲染矩阵 | G |
| cases/30-send-pipeline.yaml | 发送管线/中间件 | E6 |
| cases/40-outbound-dedup.yaml | 出站持久化/去重 | A, E |
| cases/50-aggregation.yaml | 摘要/digest 聚合 | F |
| cases/60-crawler-schedule-health.yaml | 调度/冷却/健康 | C, D |
| cases/70-browser-cookie.yaml | 浏览器/cookie | I |
| cases/80-processor.yaml | LLM processor | A5, H |
| cases/90-lifecycle-cordis.yaml | fiber 生命周期符合性 | B3, J |
| cases/95-failure-cascade.yaml | 故障注入/级联 | J |
| cases/99-shadow-e2e.yaml | 影子对比/切流验收 | 全部 |
