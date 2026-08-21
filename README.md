# kyestu

SNS 聚合转发系统（X / Instagram / TikTok / YouTube / 官网 → QQ / B站），基于时空可组合 runtime（可回滚 effect + 反应式 coeffect + fiber 生命周期，语义对齐 Cordis 论文）。idol-bbq 的 Cordis 化重构继任项目。

## 文档索引（docs/）

- [config.md](docs/config.md) — 配置指南：components + routes 两清单、needs 编译、校验、reconcile 行为、idol-bbq 导入
- [components.md](docs/components.md) — 组件开发指南：新增 crawler/processor/target 的触点清单与纪律
- [decisions.md](docs/decisions.md) — 决策记录 D1–D18（含单进程边界裁决 D16、组件作者纪律 D18）
- [bus.md](docs/bus.md) — infra/bus 的频道与可靠性语义（哪些保证有、哪些没有、丢了谁兜底）
- [parity-gap.md](docs/parity-gap.md) — 与 idol-bbq 生产的差异清单与处置状态
- [ig-cookie-rotation.md](docs/ig-cookie-rotation.md) — IG cookie 轮换运维手册
- 2026-08-16 两篇报告 — 可行性评估与 v1 落地总览（时点快照，数字以 git/代码为准）

## Quickstart

```bash
git clone <repo> && cd kyestu
bun install

# 配置二选一：
bun run import /path/to/idol-bbq/assets/config.yaml kyestu.config.yaml   # 从 idol-bbq 导入
cp examples/config.minimal.yaml kyestu.config.yaml                       # 或从最小例子改起

bun run start kyestu.config.yaml   # = bun src/main.ts
```

行为：infra 缺省自动补齐（`./data.db`、`./cache`）；配置文件 watch 自动 reconcile；HTTP 控制面 `/api/status`、`POST /api/reload`（Bearer，`?force=1` 可复位 FAILED entry）。需要 Bun >= 1.3；QQ 发送需要同文件系统的 OneBot v11 端点（NapCat 等，`ONEBOT_HTTP_URL`）。

## 测试

```bash
bun test            # 全部测试
bun run typecheck   # tsc strict（含 vendored 包 shim 面）
```

## 成熟度（诚实声明）

核心 runtime 与主链路（抓取→翻译→入库→路由→渲染→发送）有测试与生产配置冒烟背书，风控态（冷却/熔断/会话健康/路由队列/digest）已持久化到 service_state；但**尚未在生产部署实测**——真实平台抓取/发送、live relay 校准、API 面（仅 2/~45 端点）等待验证项见 [docs/parity-gap.md](docs/parity-gap.md) 的"待部署实测"区。
