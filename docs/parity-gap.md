# kyestu ↔ idol-bbq 差异清单与处置决策（2026-08-16）

## 有意决策（不改）
- LLM 组件按协议命名（processor/openai + wire_api），Google translator 不移植
- tag-storm 检测已实现、不接发送链路
- 配置为组件+路由清单，outbound 去重键格式原生
- codex-mcp-client 抛弃

## 已决待做（按优先级）
1. ~~**processor/rules**~~ ✅ 已做（2026-08-16）：`pipeline/digest-rules.ts` + `components/processor-rules.ts`，extract/merge、URL 过滤/归一化全移植（dayjs→原生 parseTimestamp）。导入器 Mechanical 映射 processor/rules。
2. **extract 回写 schedule-webhook**（必做）：showroom 排程抽取（22_7-showroom-schedule）经 `schedule_url` POST 到 live-player（生产 env:LIVE_PLAYER_SCHEDULE_WEBHOOK_URL，config.yaml:650）。挂在 extract action 的结果处理上，带 api_key/user_agent/waf_bypass_header/min_confidence。
3. ~~**cookie-keepalive 升级为 cookie 管理**~~ ✅ 已做（2026-08-16）：expandPath（$VAR/${VAR}/~）、jarStatus()（存在性/大小/年龄/sources/保活状态）、导入器 sources 汇总共享 jar 的爬虫。/api/cookies 端点仍待 API 面补齐时做。
4. ~~**LLM 提供商管理打包**~~ ✅ 已做（2026-08-16）：llm-openai 内置熔断（circuit.failure_threshold/cooldown_seconds，默认 3 次/300s，4xx 不计数，open 时直走 fallback）、unfreeze()、probe()（小请求探活，不喂熔断）、status()。
5. **x-link-ingest 做但不接**：pipeline/link-ingest.ts 独立模块（X 帖内 TikTok/YouTube/IG 链接解析抓取）。 suspicion: 与去重冲突——接入时必须走 ArticleStore.exists 同一去重键；健康期无收益，仅作故障兜底，默认不挂。
6. **bilibili-recovery-reconciliation**：投稿失败对账恢复。
7. **单次运行 harness 接口**（低）：POST 触发某 processor 单跑（等价 /api/actions/processors/run），顶替 codex 的 ad-hoc 用途。
8. **DB 迁移/压缩工具**（顶替 redaction 诉求）：sqlite dump/VACUUM INTO + zstd 压缩的导出导入，ops 级小工具。

## 不做（有理由）
- redaction 全家桶（6 服务）：内容全是公共 SNS，无敏可脱。
- crawler-health-audit：cooldown map + target_health + keepalive status 已覆盖其核心价值，部署后如暴露缺口再议。
- codex MCP agent。

## 留观（刻意不动）
- QQ 发送仅 2 次内联重试（生产 60s·2ⁿ 退避）
- digest_buffer 纯内存（生产 DB 持久化）
- sendVideo 不走 TargetRuntime 策略
- POST /api/reload 与 watch 并发未串行化

## 待部署实测
- 真实平台抓取/发送（cookie、风控、真实 OneBot/B站）
- live relay 对 tv.n2nj.moe 播放器 API 面校准
- biliup LLM 标题/标签生成（当前只有确定性模板）
- live_capture 两服务 + plan API（未移植）
- API 面：生产 ~45 端点，kyestu 只有 /api/status + /api/reload，按需补
