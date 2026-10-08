# 安全扫描整改清单 — daybreak 2026-10-08

> 性质：外部静态安全扫描（GPT daybreak / codex-security-plugin 0.1.22）的分级整改清单。基线是冻结 revision `5ce992a963e0bf9a2e60daebd7fb69b97a3162c1`（= 当时 HEAD）。原始产物在 `~/Downloads/daybreak/`（`report.md` / `findings.json` / `coverage.json` / `scan-manifest.json`，scan id `a730e69a-7a64-4f74-b339-7d890c2650b3`）。**2026-10-09：必改四条已修并提交，其余条目按下表挂起/待办。**
>
> 扫描是**静态、只读、离线**的：没跑应用/测试/浏览器，没有动态验证；结论里"可达性"按仓库内证据推断。与 `decisions.md` 的关系：采纳的条目落码后建议以 D19+ 回填决策（尤其 #3 控制面默认值与 #7 schedule 信任边界）。

## 0. 总评

10 条：medium 4 / low 6，无 high，无注入类可直接打穿的缺陷（SQL、命令、模板三处扫描均判"无问题"）。覆盖面是合理的：资源耗尽（#1 #2 #10）、控制面默认值（#3）、出口/SSRF（#4）、供应链（#5）、凭证暴露面（#6）、LLM 信任边界（#7）、参数注入（#8）、沙箱（#9）。

判定前提（若部署形态变化需重估）：

- 单操作者自用、无租户隔离；配置文件与 env 属于**可信操作者输入**，远程不可控。
- **尚未生产部署**（见 README 成熟度声明）——这是"部署前修完"而非"线上热修"，可以在改的时候顺带补测试。
- 控制面 3000 端口的暴露面取决于部署（compose 示例是 `3000:3000` 全量发布）。
- 扫描时工作树上有一批未提交改动（cookie-guard / lifecycle / import 测试等），整改要避开它们、只动下表列的文件。

## 1. 分级与处置

| # | 问题 | 严重度 | 判定 | 改动点 | 工作量 | 状态 |
|---|---|---|---|---|---|---|
| 3 | 控制面空 secret 时鉴权 fail-open | medium | **必改** | `src/components/api.ts`、`src/main.ts`、`docker-compose.example.yml`、README | 小 | **已修 2026-10-09** |
| 8 | curl transport 把 URL 当选项解析 | low | **必改** | `packages/spider/src/utils/http.ts` | 很小 | **已修 2026-10-09** |
| 1 | 媒体全量缓冲、无字节/缓存上限 | medium | **必改** | `src/pipeline/media.ts` | 小-中 | **已修 2026-10-09** |
| 2 | 卡片高度随正文无限增长，进程内同步栅格化 | medium | **必改** | `packages/render/template/img/DefaultCard.tsx`、`packages/render/src/img/index.ts`、`src/components/formatter.ts` | 小-中 | **已修 2026-10-09** |
| 7 | LLM 输出可变成带凭证的 workflow 形态 schedule | low | **建议改**（有行为变更，需拍板） | `src/pipeline/schedule-webhook.ts` | 中 | 待办 |
| 5 | `pip install biliup` 不锁版本 | low | **顺手改** | `Dockerfile` | 很小 | 待办 |
| 10 | DB 导入 gzip/zstd 解压无输出上限 | low | **顺手改** | `src/pipeline/db-archive.ts`、`scripts/db-archive.ts` | 小 | 待办 |
| 4 | 内容派生 URL 无出口校验（SSRF 面） | medium | **分期改** | 新建 `src/pipeline/net-guard.ts` + 三处接入；浏览器/渲染面二期 | 中 / 大 | 待办 |
| 6 | `--cookie` 接受明文 cookie（argv 可见） | low | 看使用方式 | `tools/bili-dyn-visibility/bili_dyn_visibility.py` | 小 | 挂起 |
| 9 | 生产镜像 Chrome `--no-sandbox` | low | **接受风险**（记录） | 无（部署架构决策） | — | 记录 |

## 2. 已修四条（2026-10-09，含回归测试）

工作树里在途的那批改动（runtime 代际守卫 / 逆守卫超时 / 导入器成环修复 / runtime-log 抽取 / stryker+fast-check 工具）逐文件过了一遍：**没有本清单这类毛病**（无新增资源上限缺口、无鉴权面、无子进程参数面；`unloadInverseGuardTimeoutMs` 反而是给了解挂上限）。唯一备注：三个新 devDependency 会随 `bun install --frozen-lockfile` 进镜像，属 #5 同类的构建面扩大，改 Dockerfile 时一并考虑 `--omit=dev`。

修法与偏差（对 §2 各小节的计划）：

- **[3]** `api.ts`：`secret` 空/纯空白时 `apply` 直接抛错（fiber FAILED、控制面不监听），除非显式 `allow_insecure: true` 或 `KYESTU_API_INSECURE=1`；`docker-compose.example.yml` 的 `KYESTU_API_SECRET` 改为 `${KYESTU_API_SECRET:?...}` 强制；README / Dockerfile HEALTHCHECK 注释同步。**没有**改监听地址（容器内绑 127.0.0.1 会打断端口映射与健康检查语义）。回归：`tests/api-guard.test.ts` ×4（默认拒绝启动 / allow_insecure / env 逃生口 / secret 覆盖全部路由含 `?force=1`）。
- **[8]** `http.ts`：新增 `HTTPClient.buildCurlArgs()`（纯函数，可测）——`assertHttpUrl` 只放行 http(s) 且拒绝前导连字符；argv 里 URL 放在 `--` 之后；加 `--proto =http,https --proto-redir =http,https`。`download_webpage`（fetch 路径）同样过 `assertHttpUrl`。回归：`packages/spider/test/utils.test.ts` 追加 ×3。
- **[1]** `media.ts` 重写下载路径：`Content-Length` 超限先拒，否则流式读写 + 硬字节计数（chunk 级中止），`.part-*` 临时文件 + `rename` 原子落盘，异常清半成品；缓存总量预算（默认 8 GiB）超限时**先淘汰超保留期（默认 14 天）的最旧对象**，仍不够则明确拒绝下载——而不是淘汰可能还挂在出站队列里的新文件；构造时清理崩溃残留的 `.part-*`。阈值可用 `KYESTU_MEDIA_MAX_BYTES` / `KYESTU_MEDIA_CACHE_MAX_BYTES` / `KYESTU_MEDIA_RETENTION_DAYS` 覆盖（单对象默认 256 MiB）。回归：`tests/media-store.test.ts` ×5（含 chunked 无 content-length 的计数路径、预算淘汰、预算拒绝）。
- **[2]** 渲染面双闸：`sanitizeCardText` 是卡片文本的唯一咽喉（估算与渲染都走它），加 `CARD_TEXT_MAX_CHARS = 2000` 上限 + `…（以下省略）` 标注，幂等且不切开代理对；`articleParser` 把 `cardHeight` 钳到 `MAX_CARD_HEIGHT = CARD_WIDTH * 6 = 3600`（BaseCard 根节点 `overflow: hidden`，超长内容被裁切）；`ImgConverter.articleToImg` 对**所有**模板断言画布高度策略，超限抛错 → `formatter.renderCard` 已 catch → 退化纯文本。偏差：未做上游 bodyText 入库截断与独立渲染 worker（#2 计划里的可选项/二期），因为单卡上限已把栅格面积和布局循环封住。回归：`packages/render/test/DefaultCard.test.ts` 追加 ×4。

验证：`bun test` 510 tests / 504 pass / 6 skip / 0 fail，`bun run typecheck` 干净（连跑两次，含一次跨文件全量复跑排除偶发）。

## 3. 必改四条的修法设计（备查，实施细节见 §2）

### 3.1 [3] 控制面空 secret fail-open

`src/components/api.ts:61` 现在是 `if (secret) { ...Bearer 校验... }`——secret 未配或为空字符串时，`/api/status`、`/api/cookie-health`、`POST /api/reload?force=1` 全部免鉴权可达；`docker-compose.example.yml:18` 的 `KYESTU_API_SECRET: ${KYESTU_API_SECRET:-}` 默认就是空，同时 `3000:3000` 发布端口。

改法：

1. `api.ts` 的 `apply`：`secret` 空（含纯空白）时**拒绝启动**（抛错 → fiber FAILED，`statusView` 的 outcome 直接可见），除非显式 `allow_insecure: true` 或 `KYESTU_API_INSECURE=1`（仅开发用）。
2. `docker-compose.example.yml`：`KYESTU_API_SECRET: ${KYESTU_API_SECRET:?set KYESTU_API_SECRET in .env}`（与同文件 `ONEBOT_HTTP_URL` 的写法一致）。
3. README 部署段补一句"未设 secret 控制面不启动"，`Dockerfile` 的 HEALTHCHECK 注释同步。
4. **不要**顺手把监听改绑 127.0.0.1：容器里 bind loopback 会让 compose 的端口映射失效、健康检查的语义也变，属于另一个行为变更。

验证：`tests/` 补三条——空 secret 启动抛错 / `allow_insecure` 放行 / 无 Authorization 一律 401（含 `?force=1`）。`bun test` + `bun run typecheck`。

### 3.2 [8] curl URL 选项注入

`packages/spider/src/utils/http.ts:82-101`：`args.push(url)` 之前没有 `--` 终止符，也没校验 scheme。`execFile` 挡住了 shell 注入，但 curl 自己会把 `--url=file:///etc/passwd` 这类前导连字符参数当选项解析；`throwOnError:false` 时 `http.ts:117-123` 会把非 HTTP 输出以 599 状态返回。当前调用方都是固定 HTTPS 主机，属于"库边界缺陷"而非现网漏洞。

改法（约 5 行）：解析 `new URL(url)`，scheme 限 `http:`/`https:` 且不得以 `-` 开头，否则抛 `HttpStatusError`/`Error`；argv 改成 `args.push('--', url)`；顺手加 `--proto =http,https --proto-redir =http,https`。

验证：`--url=file:///etc/passwd` 与 `-` 开头输入被拒（在进程创建前），重定向无法切到 `file:`，正常 HTTPS 抓取回归通过。

### 3.3 [1] 媒体下载无字节/缓存上限

`src/pipeline/media.ts:37-49`：`await res.arrayBuffer()` 全量进内存再 `Buffer.from` 复制一份再同步落盘；缓存按 URL 哈希永久保留，`formatter.ts:34/81` 还会整文件 base64 再喂渲染器。60s 超时只限时间不限字节，唯一 URL → 唯一文件，无淘汰。

改法：

1. 先看 `Content-Length`，超上限直接拒；否则 `res.body.getReader()` 边读边累计，超过**单文件上限**（建议 32 MiB）就 `abort()`、删掉 `.part` 临时文件。
2. 写 `path + '.part'` 后 `rename` 原子落盘，异常路径清理半成品。
3. 加**缓存总量上限**（建议 2 GiB，按 mtime 淘汰最旧），并在淘汰时同步清 `contentHashes` memo。
4. 可选：magic bytes 校验与声称的类型一致（挡解压炸弹/伪装图）。

验证：超限响应被中止且无残留 `.part`；query-string 换 URL 的重复下载不会撑爆总量；正常图片/视频链路回归通过。

### 3.4 [2] 卡片高度无上限

`packages/render/template/img/DefaultCard.tsx:1651-1679` 只有最小高度没有最大，正文越长 `cardHeight` 越大，`packages/render/src/img/index.ts:486-497` 里 satori/resvg 在应用主进程内同步栅格化，无超时无内存边界。website/LEAP 正文全文入库（`packages/spider/src/spiders/website.ts:1583-1595`）是上游来源。

改法：

1. `DefaultCard.tsx` 加 `MAX_CARD_HEIGHT`（建议 `CARD_WIDTH * 6` = 3600px，`CARD_WIDTH = 600`）：超限则对正文截断并在卡片尾部标注"（正文过长已截断）"，保证 `estimatedHeight` 收敛到上限。
2. `img/index.ts` 的 satori 调用前再断言一次 `width * height` 像素预算，超限抛错；`formatter.ts` 的 `renderCard` 已 catch 返回 null → 自动退化为纯文本，天然兜底。
3. 上游（可选，二期）：`website.ts` 入库前对 `bodyText`/`bodyHtml` 截断（例如 20k/100k 字符）并限图片数量。

验证：超长正文卡片高度不超过上限且带截断标注；像素预算超限时 `articleToImg` 抛错、`renderCard` 返回 null 走文本；正常卡片高度回归不变。

## 4. 建议改（有行为变更）

### 4.1 [7] LLM 输出 → schedule 写入的信任边界

`src/pipeline/schedule-webhook.ts:101-121`：`resolveScheduleType` 直接采纳模型给的 `scheduleType`，`payload.type` 还能把条目提升成 `workflow`，`stableEventKey` 采纳模型给的 `externalKey`，`normalizePayload` 把模型给的整个 `payload` 对象原样转发，最终带 `apiKey` POST 到 schedule 服务。提示注入的发布者因此可以从"内容抽取"跨到"带凭证的工作流写入"。

改法：

1. `scheduleType` 与 `externalKey` **一律本地推导**，丢弃模型值（`externalKey` 保持现有 `${sourceRef}:event:${digest}` 生成路径不变，幂等语义不破）。
2. `extract` 动作强制 `reminder`，`payload` 只走本地构造的 `idol_bbq_time_event_candidate` schema（即现在 `normalizePayload` 的 else 分支）。
3. 只有 `plan` 动作允许 `payload`，且按 `payload.type` 白名单过滤、未知键丢弃。
4. 接收端（live-player schedule 服务）应独立鉴权每种 scheduleType，而不是只认共享 key——这条在仓库外，见 §5 开放问题。

**需要先确认**：下游是否真的依赖模型直接给 `scheduleType`/`payload.type`/`externalKey`？依赖则按上面收紧会改变行为，需要保留白名单内的显式通路。工作量中等，改前先回答这个问题。

## 5. 顺手改

### 5.1 [5] biliup 未锁版本

`Dockerfile:62-74`：`pip install --no-cache-dir biliup` 无版本/哈希约束，同一冻结 revision 重建会拿到不同的上游代码，且安装发生在 `USER bun` 之前（root 阶段）。改法：钉死当前解析到的版本（`biliup==X.Y.Z`），或写 `scripts/biliup-constraints.txt` + `--require-hashes`；构建说明里加一句"升级 biliup 需显式改 pin"。想更严就单独 build stage 装 wheel、只 COPY 进运行时镜像（可后置）。

### 5.2 [10] DB 导入解压无上限

`src/pipeline/db-archive.ts:83-88`：gzip 走 `gunzipSync(readFileSync())` 全量进内存，zstd 直接写盘，都无输出上限/超时，且 SQLite header 校验发生在解压**之后**。触发前提是"操作者主动导入一个不可信归档"，风险低但改起来便宜：

1. gzip 改 `zlib.createGunzip()` 流式解压 + 字节计数，超上限（建议 2 GiB 或 `原始库大小 * N`）中止并清理。
2. zstd：解压前用 `zstd -l` 读 frame 的解压尺寸，声明值超限直接拒；再加 `run` 的超时与 kill；解压后比对实际大小兜底。
3. 归档压缩输入大小也给个上限。
4. 补 gzip/zstd 炸弹回归测试。

## 6. 挂起 / 接受

### 6.1 [6] `--cookie` 明文 cookie 进 argv（挂起）

`tools/bili-dyn-visibility/bili_dyn_visibility.py:203-215` 把非文件的 `--cookie` 值当明文 cookie 用，README 也这么宣传，SESSDATA/bili_jct 会留在进程表里。这是辅助 CLI，且 quick-start 示例本来就用 cookie 文件。若继续用：加 `--cookie-stdin`（或要求 0600 文件并校验权限），明文模式打警告并在文档里删掉该用法。是否改取决于这个工具实际怎么被调用。

### 6.2 [9] Chrome `--no-sandbox`（接受风险，记录）

`Dockerfile:71` `ENV NO_SANDBOX=true` → `src/components/browser-pool.ts:248-258` 给每个 Chrome 加 `--no-sandbox` + `--disable-setuid-sandbox`。容器内默认就得这么跑（除非配 userns/seccomp 让 Chrome 沙箱可用），改代码大概率把抓取搞挂。三条出路按代价排序：① 记录风险（本条现状）；② 支持 `KYESTU_BROWSER_SANDBOX=1` 时去掉两个 flag，由部署方自己配好沙箱环境；③ 浏览器拆到独立的无凭证/无 DB 挂载/限制出口的容器或微VM。属部署架构决策，不在本批。

## 7. 开放问题（来自扫描，决定 #3/#4 的最终定级）

1. 生产哪些网络能打到 3000 端口？非空 API secret 是否在示例配置之外**总是**被强制？
2. 有什么出口策略阻止 kyestu（含浏览器）访问内网/链路本地/云元数据地址？——没有的话 #4 一期是必需项，二期也要排期。
3. 下游 schedule 服务执行哪些 workflow 类型与字段？是否独立鉴权？（决定 #3.1 的收紧范围）
4. 生产的内存/磁盘配额与 `/proc` 可见性策略？（决定 #1/#2 的阈值取值）

## 8. 扫描覆盖与已判"无问题"的面

SQLite 参数化/迁移/幂等、crawler 身份与路由选择、QQ/OneBot 与 B站协议载荷、YAML/env 加载与 reload 序列化、缓存与浏览器 profile 路径处理——扫描均判"无问题"，无需整改。排除项：`assets/fonts/**`（二进制字形）、`packages/{render,spider}/test/**`（非生产测试，只做安全搜索）、`tools/bili-dyn-visibility/__pycache__/**`。
