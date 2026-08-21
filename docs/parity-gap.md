# kyestu ↔ idol-bbq 差异清单与处置决策（2026-08-16）

## 有意决策（不改）
- LLM 组件按协议命名（processor/openai + wire_api），Google translator 不移植
- tag-storm 检测已实现、不接发送链路
- 配置为组件+路由清单，outbound 去重键格式原生
- codex-mcp-client 抛弃

## 已决待做（按优先级）
1. ~~**processor/rules**~~ ✅ 已做（2026-08-16）：`pipeline/digest-rules.ts` + `components/processor-rules.ts`，extract/merge、URL 过滤/归一化全移植（dayjs→原生 parseTimestamp）。导入器 Mechanical 映射 processor/rules。
2. ~~**extract 回写 schedule-webhook**~~ ✅ 已做（2026-08-16）：`pipeline/schedule-webhook.ts` 全移植（候选归一化/stableEventKey/WAF header/env: 解析/min_confidence）；processor/openai 的 extract/plan action 成功后自动回写（不阻断管道）；crawler 支持 post_processors 运行时解析（生产 15 处引用 22_7-event-time-extract 不在 connections 里，必须走这条）。导入器零改动（post_processors 随 cfg_crawler 透传，schedule_* 留在处理器配置）。
3. ~~**cookie-keepalive 升级为 cookie 管理**~~ ✅ 已做（2026-08-16）：expandPath（$VAR/${VAR}/~）、jarStatus()（存在性/大小/年龄/sources/保活状态）、导入器 sources 汇总共享 jar 的爬虫。/api/cookies 端点仍待 API 面补齐时做。
4. ~~**LLM 提供商管理打包**~~ ✅ 已做（2026-08-16）：llm-openai 内置熔断（circuit.failure_threshold/cooldown_seconds，默认 3 次/300s，4xx 不计数，open 时直走 fallback）、unfreeze()、probe()（小请求探活，不喂熔断）、status()。
5. **x-link-ingest 做但不接**：pipeline/link-ingest.ts 独立模块。去重冲突已排除（2026-08-16 审计）：用平台原生 a_id 即被 L1 文章级去重挡住。健康期无收益，仅作故障兜底，默认不挂。
6. ~~**bilibili-recovery-reconciliation**~~ ✅ 已做（2026-08-16）：`pipeline/bilibili-reconcile.ts`（archives 分页拉取、cookie_file/sessdata 两路凭证、按 source url 匹配补种 forward_by+outbound sent、marker 消费留 .bilibili-reconciled 结果、零 target 留 marker 重试）。target/bilibili 组件启动时注册，进程级一次性调度（marker: env KYESTU_DB_RECOVERY_MARKER，默认 /tmp/kyestu/db-recovered.json，`reconcile_on_recovery: false` 可关）。
7. **单次运行 harness 接口**（低）：POST 触发某 processor 单跑（等价 /api/actions/processors/run），顶替 codex 的 ad-hoc 用途。
8. ~~**DB 迁移/压缩工具**~~ ✅ 已做（2026-08-16）：`pipeline/db-archive.ts` + `scripts/db-archive.ts` CLI（export/import）。VACUUM INTO 碎片整理后压缩，zstd CLI 优先、node:zlib gzip 兜底；导入按魔数识别格式、校验 sqlite 头、覆盖前自动 .bak 备份、非空库需 --force。镜像已加 zstd 包。

## 不做（有理由）
- redaction 全家桶（6 服务）：内容全是公共 SNS，无敏可脱。
- crawler-health-audit：cooldown map + target_health + keepalive status 已覆盖其核心价值，部署后如暴露缺口再议。
- codex MCP agent。

## 留观（刻意不动）
- QQ 发送仅 2 次内联重试（生产 60s·2ⁿ 退避）
- digest_buffer 纯内存（生产 DB 持久化）
- ~~冷却/会话健康板纯内存，重启即风控清零~~ ✅ 已解（2026-08-21）：CooldownMap 与 SessionHealthBoard 写穿 service_state 表（`pipeline/service-state.ts`，键 `cooldown:<entry>:<url>` / `session-health:<key>`），fiber 重建与进程重启后在组件 apply 内同步水合；冷却存绝对截止时间戳，过期不复活，退避等级随条目存续
- sendVideo 不走 TargetRuntime 策略
- ~~POST /api/reload 与 watch 并发未串行化~~ ✅ 已解（2026-08-21）：Loader.reconcile 入口 promise-chain 串行化，后到者排队不交错；FAILED entry 经 POST /api/reload?force=1 显式复位（默认行为不变，watch 永不自动重试 FAILED）

## 待部署实测
- 真实平台抓取/发送（cookie、风控、真实 OneBot/B站）
- live relay 对 tv.n2nj.moe 播放器 API 面校准
- biliup LLM 标题/标签生成（当前只有确定性模板）
- live_capture 两服务 + plan API（未移植；导入器对 live_capture 配置跳过并 warning，不再产出未注册 entry）
- API 面：生产 ~45 端点，kyestu 只有 /api/status + /api/reload，按需补
