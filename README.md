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

## 部署（Docker）

```bash
docker build -t kyestu .   # 镜像为 linux/amd64（Chrome 钉版 .deb 仅 amd64）；arm64 主机加 --platform linux/amd64
docker run -d --name kyestu --restart unless-stopped \
  -e ONEBOT_HTTP_URL=http://<napcat>:3001 \
  -e KYESTU_API_SECRET=<random> \
  -e DATABASE_PATH=/app/data/data.db -e CACHE_DIR=/app/data/cache \
  -v "$PWD/kyestu.config.yaml:/app/kyestu.config.yaml:ro" \
  -v kyestu-data:/app/data \
  -p 3000:3000 kyestu
```

compose 见 [docker-compose.example.yml](docker-compose.example.yml)（build + env + volume + restart 的最小样例）。

需要持久化的路径（**不**用 VOLUME 指令强声明，避免匿名卷惊喜，按需挂载）：

| 路径 | 来源 | 内容 |
|---|---|---|
| `/app/kyestu.config.yaml` | CMD 参数 | 配置，建议只读挂载；watch 自动 reconcile |
| `$DATABASE_PATH`（默认 `/app/data.db`） | env | SQLite 主库：文章/出站幂等/service_state 风控态 |
| `$CACHE_DIR`（默认 `/app/cache`） | env | 媒体缓存 + 浏览器 profile |
| 各 `cookie_file` | 配置内路径 | 平台 cookie；指到挂载卷内 |
| `$KYESTU_DB_RECOVERY_MARKER`（默认 `/tmp/kyestu/db-recovered.json`） | env | B站 DB 恢复 marker，默认在容器 tmp 层、重建即丢；需保留就指到卷内 |

健康检查：镜像内置 `HEALTHCHECK` 打 `/api/status`。若配置了 api secret，**必须经 `KYESTU_API_SECRET` env 注入**（配置里写 `secret: env:KYESTU_API_SECRET`），健康检查才能带同一个 Bearer；secret 直接写死在配置文件里则健康检查恒 401，此时改用 `docker inspect --format '{{json .State.Health}}' kyestu` 观察改为进程级判断，或自行覆盖 `--health-cmd`。注意 200 只证明控制面在服务——FAILED fiber 也返回 200，fiber 健康需对 payload 的 `state`/`taints` 做外部告警。


## 测试

```bash
bun test            # 全部测试
bun run typecheck   # tsc strict（含 vendored 包 shim 面）
```

## 成熟度（诚实声明）

核心 runtime 与主链路（抓取→翻译→入库→路由→渲染→发送）有测试与生产配置冒烟背书，风控态（冷却/熔断/会话健康/路由队列/digest）已持久化到 service_state；但**尚未在生产部署实测**——真实平台抓取/发送、live relay 校准、API 面（仅 2/~45 端点）等待验证项见 [docs/parity-gap.md](docs/parity-gap.md) 的"待部署实测"区。
