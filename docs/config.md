# kyestu 配置指南

设计目标：一张组件清单 + 一张路由清单，没有五张 connections 映射，没有 id/name 双键，没有隐式兜底。

## 最小例子

```yaml
components:
  - id: x-main
    use: crawler/x
    with:
      cookie_file: cookies/x.txt
  - id: ja-zh
    use: processor/deepseek-v4-flash
    with:
      api_key: env:DEEPSEEK_API_KEY
  - id: card
    use: formatter/img-tag
  - id: group-1
    use: target/qq
    with:
      group_id: 123456

routes:
  - from: x-main
    via: [card]
    to: [group-1]
  - from: ja-zh
    to: [x-main]
```

## 语义

- **components**：每个条目 = 一个运行时 fiber。
  - `id`：必填，全局唯一，reconcile 的对齐键。
  - `use`：必填，组件类型（注册表里的名字，`kind/name` 形式）。
  - `with`：透传给组件的配置，原样交给 `apply(ctx, with)`。
  - `needs`：可选，声明"我依赖哪些组件"（id 列表）。
  - `disabled: true`：保留条目但不实例化。
  - `isolate: { key: realm }`：可选，coeffect 隔离（同 key 在该子树解析到独立绑定）。
- **routes**：`from → via → to` 一条链。每个箭头都是一次 needs：`via[0]` needs `from`，`via[i+1]` needs `via[i]`，`to[]` needs 链尾。数据流方向 = 依赖方向，下游只在上游 ACTIVE 后激活，上游消失时下游先停用。
  - `via`/`to` 都可省略：只有 `to` 是直连；只有 `via` 是纯链。
- **defaults**：按 kind（`use` 的 `/` 前段）给默认值，被条目自己的 `with` 覆盖（浅合并）。

## 校验（加载前全部检查完才动系统）

- duplicate id / 缺 id 缺 use / 未注册组件类型
- route 引用未知组件、自环
- needs 图有环（报出环路径）
- `with` unknown-key 告警：组件在 `Component.knownWithKeys` 里声明自己消费的键；多出来的键在加载前 `console.warn`（告警不拒绝，保持兼容）——拼错的键不再静默吃默认值

## Reconcile 行为

`loader.reconcile(entries)` 先校验、后按最小扰动分发：

| 变化 | 动作 |
|---|---|
| 新增 id | create |
| 删除 id | dispose（等其完整卸载，键空间干净后才继续） |
| `use` / `with` / needs 变化 | rebuild（先完整卸载旧 fiber 再建新的，同 id） |
| `disabled` true↔false | disable（保留条目）/ enable |

未变条目零扰动（fiber uid 不变）。下游因 provider 替换而在原 fiber 内重启（uid 不变，generation 递增）。

## 从 idol-bbq 导入

```bash
bun scripts/import-idol-bbq.ts <idol-bbq/assets/config.yaml> kyestu.config.yaml
```

- crawlers → `crawler/<kind>`（按 origin/websites 识别平台；x.com/i/lists → `crawler/x-list`）
- processors → `processor/openai`（按协议命名；`wire_api` 推断：显式值 > base_url 含 `/responses` > 默认 chat_completions；Google/Deepseek v1/Mechanical 跳过并 warning）
- formatters → `formatter/<render_type>`；targets → `target/<platform>`
- connections 五图 → routes（crawler→formatter→target 主流；crawler-processor 翻成 `processor → crawler` 的服务边）
- 顶层 `cfg_*` → `defaults:`；`api`/`live_capture` → `app/*` 组件
- forwarder 的 origin 自动绑定是遗留行为，不导入（输出 warning，需要时手工补 route）
