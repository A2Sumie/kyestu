# cordis-forwarder 测试集

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

## harness 约定

- **fake clock**：cron/tick/冷却/摘要窗全部时间相关，一律虚拟时钟驱动。
- **capture 接收端**：OneBot/B站 发送走 `IDOL_BBQ_OUTBOUND_SEND_MODE=capture` 到 JSONL，对比消息序列。
- **平台 fake**：X/IG/TT/YT 用录制 payload；oembed/probe 用本地 stub。
- **hermetic 渲染**：`RENDER_REMOTE_ASSETS=0` + 固定 FONTS_DIR。
- **影子运行**：独立 DB 副本 + 独立 CACHE_DIR；旧系统跑 live 或 capture，新系统跑 capture；发散点先查 SH-02 白名单。

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
