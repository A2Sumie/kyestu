# B 站投稿标题策略（biliup 译题 / 概括）

适用范围：`src/pipeline/bili-title.ts`（纯逻辑）+ `src/pipeline/biliup.ts`（上传装配）+ `src/components/target-bilibili.ts`
（LLM 接缝注入）。与 idol-bbq `app/tweet-forwarder/src/middleware/forwarder/biliup.ts` 的标题整改（commit
`d56c0d2`、`idol-bbq-utils/docs/zh/tweet-forwarder/biliup-title-policy.md`）行为一致；差异见文末对照表。

核心口径：**B 站投稿的主标题 = 原标题的翻译**。有原标题的来源（YouTube 视频/Shorts）一律"翻译优先于生成"，
不允许模型另起炉灶写新标题；没有原标题的来源（X / Instagram / TikTok 文案）才走"概括"路径。website 文章带
作者手写标题，永不进 LLM 标题链路。

## 标题格式模板

统一默认格式（代码默认 `DEFAULT_TITLE_TEMPLATE`，`video_upload.title_template` 可覆盖）：

```
【{account_title}】{upload_summary}   →   【22/7 北原実咲】08.16_26 <标题正文>
```

- `【22/7 …】` 品牌前缀：`22/7` + 账号显示名（`username ?? u_id`）。识别不到账号时退化为 `【22/7】`。
  B 站搜索锚点与频道识别，保留。
- `MM.DD_YY` 发布日期码（如 `06.17_26`）：按时间浏览、同题去重，保留。
- 标题正文：YouTube = **原标题的中文翻译**；其它来源 = 正文开头事实的中文翻译/浓缩。
- **`[YT]/[X]/[ins]/[TT]` 来源括号已去掉**：无搜索价值、像搬运标记、占 80 字预算；来源在简介 `来源:`
  行署名。需要旧行为的自定义模板仍可用 `{source_tag}` 键（如 `【{account_title}】[{source_tag}] {upload_summary}`）。

## 译题（translate_original_title）

- `original_title`（content 首行）是**唯一翻译素材**：忠实翻译，不改写、不扩写、不概括、不补写。
- 保留成员名、角色名、作品名、曲名、节目名、数字、日期、期数、序号与原文结构；不截断、不漏译关键名词。
- 专有名词按译名表（`assets/knowledge/22_7/translation_terms_22_7_ja_zh.json`，65 条，自 idol-bbq
  `assets/knowledge/22_7/translation/` 取译名事实）的 `target` 写法，随 prompt（`glossary` 字段）下发：
  天城サリー → 天城莎莉、北原実咲 → 北原实咲、ナナニジハウス → 七虹家…；表内注明保留日文的歌名/节目名
  （「命の続き」等）不再被误判为未译。
- few-shot 3 例；禁标题党词与译注。原文原标题照旧进简介首行：`原标题: <原文>`。

## 概括（summarize_post_title）

- 来源无独立标题：把正文开头主要信息忠实翻译并浓缩为中文标题；不得脑补。
- 不得用"成员名+日期"空壳当标题主体。
- 模型若把账号名/日期回显进标题，确定性后处理会剥掉开头上下文（译题模式不剥，译文保持忠实）。

## 确定性后处理（对 LLM 输出与确定性标题都生效）

1. 空白/括号规范化：去控制符、合并空白、剥无配对书名号/引号。
2. 平台词/搬运词清洗：删 `YouTube/Twitter/TikTok/Instagram/推特/搬运/转载/…`（缩写 `yt/tt/x/…`
   仅独立成词时删）。
3. emoji 收敛：连续 3+ 折 2；正常符号（♪、～、【】、#tag#）保留。
4. **语义安全截断**：>80 字（码点计）按空格/分隔符/收尾括号边界截断 + 单个 `…`，不切半个词/人名；
   无边界时在预算内硬截。标题正文候选（`upload_summary` 的 headline）先截 40 字。
5. **合格性校验**：无汉字拒收；假名占绝对多数（未译回显）拒收；标题党禁词拒收。超长不拒收，安全截断。
6. **兜底链**：`LLM 译题 → translation 首行 → 原标题原文 → 【22/7】MM.DD_YY 日期壳 → 平台标签+时间+
   article_id 硬壳`。LLM 不可用/译文不合格/解析失败时确定性标题原样交付；空标题、纯日期、纯标点
   一律走壳，不产空壳正文。

## LLM 输入 / 输出

输入 JSON（`buildTitleGenerationInput`）：

```json
{
  "task": "translate_original_title | summarize_post_title",
  "original_title": "仅 translate 模式：原标题（唯一翻译素材）",
  "text": "正文文本块（译文优先，去重）",
  "glossary": [{ "source": "天城サリー", "target": "天城莎莉", "note": "..." }],
  "title_min_chars": 4,
  "title_max_chars": 32,
  "source_context": { "platform": "...", "source_tag": "...", "type": "...", "username": "...", "user_id": "...", "article_id": "...", "source_url": "...", "date": "...", "time": "..." }
}
```

`title_min_chars` / `title_max_chars` 是给模型的**目标长度参考**（translate 模式允许更短的忠实译文，
校验下限降到 2 字），硬约束只认 B 站 80 字上限与安全截断。输出 `{"title_zh": "…"}`（`zh_title`/
`chinese_title`/`title` 亦收），纯文本单行译题也可直接采用。

## 配置（target/bilibili → `video_upload.title_generation`）

```yaml
video_upload:
  title_generation:
    enabled: true            # false = 关闭
    base_url: https://…/v1/chat/completions   # OpenAI 兼容（chat_completions 或 responses）
    api_key: env:DEEPSEEK_API_KEY
    model_id: deepseek-v4-flash
    wire_api: responses      # 显式 > base_url 含 /responses > chat_completions
    target_min_chars: 8      # 给模型的长度参考
    target_max_chars: 32
    prompt: …                # 可选：整体覆盖默认 prompt（译题/概括规则随之失效，需自带）
    # temperature / top_p / max_tokens / response_format / extended_payload /
    # reasoning_effort / request_timeout_ms / circuit / fallback 同 processor/openai
```

- **缺省 = 关**（只有确定性模板）。与 idol-bbq 的差异：idol-bbq 未配置时默认开并复用 tag_generation
  凭据；kyestu 没有 LLM 标签链路，无凭据可复用，故显式配置才启用。
- `title_generation: false` 或 `enabled: false` 或缺 `api_key` → 确定性模板。
- LLM 调用复用 `processor/openai` 的 `OpenAiProcessorClient`（重试/熔断/fallback），熔断状态走
  service_state 键 `llm-circuit:<target-entry-id>:title`。
- 从 idol-bbq 导入：`metadata_templates.{title,description}` → `title_template`/`desc_template`
  （`{{key}}` → `{key}`，显式模板优先并告警）；`title_generation.provider`（DeepSeekV4Flash/
  DeepSeekV4Pro/Hy3Free/OpenaiLike）映射为端点默认值（D5：厂商名只在导入器出现）；`tag_generation`
  不移植并告警（静态 `tags` 保留）。

## 与 idol-bbq 的行为对照

| 项 | idol-bbq（d56c0d2） | kyestu（本实现） | 一致性 |
|---|---|---|---|
| 主标题=原标题忠实翻译（YouTube） | ✅ | ✅ | 一致 |
| X/IG/TT 忠实概括 / website 不进 LLM | ✅ | ✅ | 一致 |
| 模板去 `[来源]` 段、留品牌前缀+日期码 | ✅ `【{{account_title}}】{{upload_summary}}` | ✅ `【{account_title}】{upload_summary}`（占位符语法用 kyestu 单括号） | 一致（语法差异） |
| 原标题进简介 `原标题:` 行（去重） | ✅ | ✅ | 一致 |
| few-shot 译题 prompt + 65 条译名 glossary | ✅ | ✅（同一张译名表，只取译名事实） | 一致 |
| 校验：无汉字/假名绝对多数/标题党拒收 | ✅ | ✅ | 一致 |
| 平台词清洗、emoji 收敛、≤80 语义安全截断 | ✅ | ✅ | 一致 |
| 兜底链 LLM译题→译文首行→原标题→日期壳→硬壳 | ✅ | ✅ | 一致 |
| 输入 JSON（task/original_title/text/glossary/title_min/max/source_context） | ✅ 另含 tags 生成字段 | ✅ 无 tags 字段（kyestu 无 LLM 标签链路） | 标题侧一致 |
| LLM 标签生成 | ✅（与标题可合并一次调用） | ❌ 不移植（遗留项） | 缺口 |
| title_generation 缺省 | 默认开（复用 tag_generation 凭据） | 缺省关（显式配置启用） | 有意差异（本文档） |
| `cfg_processor.prompt` 覆盖 | ✅（覆盖后译题规则失效） | ✅ 同语义 | 一致 |
