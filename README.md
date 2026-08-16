# kyestu

> **⚠️ WIP**：本项目仍处于工作进展中。配置格式、CLI 参数与运行时行为可能随提交发生变化，请以最新 `main` 分支为准；接入前建议固定到具体 commit。

SNS 聚合转发系统：定时抓取 **X / Instagram / TikTok / YouTube / 官网**，经翻译、去重、渲染后转发到 **QQ 群 / B 站动态与视频投稿**。

底座是一个自研的时空可组合 runtime（可回滚 effect + 反应式 coeffect + fiber 生命周期，源自 Cordis 论文范式）：配置即组件清单 + 路由清单，改配置即热 reconcile，依赖按图自动排序激活/停用，失败自动部分恢复。

## 快速开始

需要 [Bun](https://bun.sh) ≥ 1.3。

```bash
git clone <repo> && cd kyestu
bun install
```

**方式一：从 idol-bbq 导入（推荐迁移用户）**

```bash
bun run import /path/to/idol-bbq/assets/config.yaml kyestu.config.yaml
# 编辑 kyestu.config.yaml：cookie 路径、onebot http_url、api secret
export DEEPSEEK_API_KEY=...   # 配置里 env: 引用的密钥
bun run start kyestu.config.yaml
```

**方式二：最小配置从零开始**

```bash
cp examples/config.minimal.yaml kyestu.config.yaml
# 按注释改成你的账号 / 群号 / 密钥
export ONEBOT_HTTP_URL=http://127.0.0.1:3001
bun run start kyestu.config.yaml
```

启动后：

- `db` / `bus` / `media-store` / `browser-pool` 未声明时自动补本地默认值（`./data.db`、`./cache`）
- fiber 按依赖顺序激活；配置文件被 watch，保存即 reconcile（也可用 `POST /api/reload`）
- 管理 API：`GET /api/status`、`POST /api/reload`（端口默认 3000，设了 `secret` 则需 `Authorization: Bearer`）

> macOS 开发机防护：无 Xvfb 时 headed 浏览器模式自动降级 headless，不会弹前台 Chrome。

## Chrome 供给

浏览器解析链：`PUPPETEER_EXECUTABLE_PATH` 环境变量 → 系统 Chrome（`channel: chrome`）→ 自动下载 Chrome for Testing `142.0.7444.175`（与 idol-bbq 生产镜像同版）到 `cache/browser/chrome`，持久缓存不重复下载。裸机零配置即可跑。

Docker（推荐部署方式，Chrome/ffmpeg/biliup venv 全内置，路径与 idol-bbq 生产布局一致）：

```bash
docker build -t kyestu .
# 配置里把 db path / cache_root 指到 /app/data 下即可持久化
docker run -v $PWD/kyestu.config.yaml:/app/kyestu.config.yaml -v kyestu-data:/app/data kyestu
```


## 配置一览

```yaml
components:
  - id: x-main
    use: crawler/x              # crawler/{x,x-list,instagram,tiktok,youtube,website-227,website,leap,messageboard}
    with:
      websites: ['https://x.com/account']
      cookie_file: cookies/x.txt
  - id: ja-zh
    use: processor/openai       # wire_api: responses | chat_completions，支持 fallback
    with: { base_url: ..., api_key: env:DEEPSEEK_API_KEY, model_id: deepseek-chat }
  - id: fmt-card
    use: formatter/text-card    # text / text-card / img / img-tag / raw-text 等 10 种
  - id: group-1
    use: target/qq
    with: { group_id: 123456789 }
  - id: bili
    use: target/bilibili        # 文字/图文动态 + 视频投稿（biliup）

routes:
  - from: x-main
    via: [fmt-card]
    to: [group-1, bili]
  - from: ja-zh                 # 翻译器挂到 crawler
    to: [x-main]
```

完整字段见 [docs/config.md](docs/config.md)。

## 功能现状

**抓取**：调度窗口 + jitter + 最小间隔；冷却分类与 ×2ⁿ 升级、Retry-After、私密/无效账号 24h 熔断；X-teaser ↔ 主平台视频 pairing（90min 窗）。

**处理**：OpenAI 协议双 wire（responses / chat_completions）+ 一级 fallback；关键词/时效/replace 策略；媒体可见性去重。

**渲染**：10 种 render_type；卡片与**摘要聚合卡**均用 vendored 的 idol-bbq 同款模板渲成 PNG。

**发送**：QQ（消息段、限速、重试纪律、outbound 去重）；B 站（文字/图文动态、视频投稿）；聚合窗（阈值 flush / send-first-immediately / digest 合并）。

**运维**：live relay（beta）；tag-storm 检测已实现但未接发送链路；cookie 保活属运维侧脚本。

## 开发

```bash
bun test            # 249 用例：core / loader / config / 导入器 / 组件 / e2e
bun run typecheck   # tsc strict
```

文档：[可行性评估](docs/2026-08-16_cordis化可行性评估-idol-bbq-report.md) · [v1 落地总览](docs/2026-08-16_kyestu-v1落地总览-report.md) · [决策记录](docs/decisions.md) · [配置指南](docs/config.md)；`testset/` 为 parity/conformance 用例集。

## License

MIT（见 [LICENSE](LICENSE)）。`packages/*` 与 `assets/migrations` vendored 自 [idol-bbq](https://github.com/ChocoLZS/idol-bbq)（MIT © ChocoLZS），`assets/fonts` 为 OFL 字体，详见 [NOTICE](NOTICE)。
