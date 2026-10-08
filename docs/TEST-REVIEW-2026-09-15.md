# 测试评审与设计反馈 — 2026-09-15

> 性质：外部系统测试 + cordis 范式查漏的原位反馈。不改既有 docs；与 decisions.md 的关系：本文的发现若被采纳，建议以 D19+ 决策记录回填。姊妹报告（含基线输出与完整证据）：`.agent/reports/2026-09-15-kyestu-system-test.md`。

## 0. 总评

基线三跑全绿（445 pass / typecheck 干净 / smoke 7 pass），测试质量在抽查中未发现"拔断言也不红"的弱测试。**但两个真 bug 与三个范式缺口在行覆盖率报表上全部不可见**——runtime.ts 99.72% 行覆盖、schema.ts 100% 行覆盖与它们共存。本批修复 2 bug + 新增 21 测试（466 pass），剩余缺口分级记录如下。

> **2026-09-15 追加闭环**：§2 的热替换重叠窗、UNLOADING 滞留与 §3 的 cookie-keepalive 同构三项已全部修复（469 pass / typecheck 干净 / smoke 7 pass），各条目内标注"已修"与修法；修复引入的新设计取舍见 §5。

## 1. 已修复（本批，含回归测试）

1. **crawler 跨代际 ghost write**（`src/components/crawler.ts`）：在途 round 的 `cooldowns.succeed/hit`、`board.record` 无代际守卫，rebuild 后旧代际簿记写入共享 store（实测：ghost 写入 rate_limit 冷却行；反向 ghost 删除新代际冷却行）。修复：簿记前 `fiber.isCurrent(generation)` 检查 + tick 入口 `fiber.wrap(round)`。回归：`tests/crawler-generation.test.ts` ×2。**建议 D18 §5 补一句：fetch 可不挂逆，但其簿记不在豁免内**（router.ts 的 `alive` 注释是先例）。
2. **导入器 processor-formatter 成环**（`src/import/idol-bbq.ts`）：via 链含 processor 与服务边互成环，`compileConfig` 必抛 dependency cycle——凡用 processor-formatter 连接的 idol-bbq 配置导入后无法启动。修复：processor 不进 via 链 + 无属主 warning。回归：`tests/import.test.ts` ×2。
3. 加固：cookie-keepalive `armedTimers` 逆后幽灵回调 delete-guard（防御性，无测试可达）。

## 2. 范式缺口（测试实证）

- **[已修] 热替换重叠窗非原子**：旧 provider 卡在 waitDependents 时键绑定仍在 store，同键新 provider 被 `coeffect key already provided` 击杀且 FAILED 不自愈。**修法（runtime 语义，即原"评估 retiring 键让位"方向）**：`writeEntry` 对 owner 已 `retired` 的滞留绑定改为继任让位——retiring 即语义上已离开（L-Leave），其物理残留不应击杀继任者；旧 fiber 的 deferred inverse 有 `removeEntryIf` 值守卫，天然无法误删继任绑定。active/loading/root 属主的冲突仍硬抛（单源纪律不变，`duplicate provider` 生命周期测试仍钉住）。回归：`tests/fiber-windows.test.ts` 的 hot-swap succession 用例（先红后绿）。取后者弃"FAILED 自愈重试"方案：继任让位对消费方原子（键不离开 store，仅 owner 换身份，走既有 provider-replacement 通知路径），无 FAILED 可见窗、无重试环风险。
- **[已修] UNLOADING 滞留无自身信号**：自身逆悬挂的 fiber 曾永滞 UNLOADING，零 taint 零事件，还会楔死 `root.dispose()`（SIGTERM 关不掉进程）。**修法**：`startUnload` 的自有逆阶段纳入护栏（`runInversesGuarded`）——超时后 fiber 给自己记 guard taint + 发 `phase:'inverses'` 的 timeout 事件 + `detachAccumulator()`（僵尸 drain 持有捕获的旧数组，吃不到后续代际注册进新数组的逆）+ 放行至终止态。回归：fiber-windows reaper ×3（含僵尸 drain 跨代际隔离）。`KyestuEvent` timeout 增 `phase?: 'dependents'|'inverses'`（向后兼容的可选字段）。
- **dispose-during-LOADING 惯性语义已钉住**：在途迭代必然落地（获取副作用不可防，仅保证逆配对）。建议写入 components.md，作为组件作者的明示前提。

## 3. 设计层观察（代码证据）

- **[已修] cookie-keepalive 与 G1 同构**：`runJob` 续体在逆之后仍 `board.record` 并写透 service_state——重装在途 job 可让陈旧 fresh 覆盖新 quarantine 的持久值（重启后水合幽灵）。**修法**：按建议加 `alive?: () => boolean` 接缝，`runJob` 成功/失败两路簿记前各检查一次；组件侧以 `fiber.isCurrent(generation)` 注入（与 crawler 同接缝，比逆时刻 flag 更严——覆盖整个撤退窗）。回归：`tests/cookie-guard.test.ts` ②c（实测红：store 持久值被幽灵 fresh 覆盖）。
- **缺席矩阵未成文**：crawler 对 browser/cookie-health 缺席处理良好且有注释自证；建议把"每组件 × 每 inject 键缺席行为"做成参数化机械用例。`formatter.ts` 声明 `inject: ['media-store']` 又 `?? null`（:60）——inject 保证下的死代码，语义含混。
- **D18-4 轻微同类未登记**：`formatter.ts:11` 模块级 `process.env.FONTS_DIR ||=`（模块导入期副作用）。
- **Root.idle() 对挂住 inertia 的 fiber 永不返回**——测试/调试助手，建议加超时或文档标注（本批测试踩到两次，改轮询规避）。
- **router at-least-once 边界已钉住**：target 缺席=defer 60 次丢弃+taint；target 抛错=drop+taint 不重试（`tests/router-queue.test.ts`）。不对称像有意但未成文——建议 bus.md 补一句。

## 4. metric adequacy（对"成熟度诚实声明"的度量层补充）

README 的诚实声明是准确的；本批证据补充的是**度量口径**：行覆盖/CRAP 落在时空可组合 runtime 上系统性失明——组件层 CC 趋 1 永远绿，kernel 层 CC 尖峰半不可约，行覆盖对窗口语义（两事件之间的区间）与用例类（行共享）全盲。建议的替换/补充度量（详见姊妹报告 §5.4）：**转换覆盖**（onEvent 迁移序列矩阵）、**缺席矩阵**、**等价性 PBT**（confluence.test.ts 的手写 3 排列可机械化）、**manifest 对抗测试**（contract-keys 元测试是雏形）。`bun test --coverage` 的报表建议仍保留——它的价值在"指出从未执行的死代码"（本批 router 两行区即由此定位），而非"证明语义测过"。

## 5. 追加闭环修复引入的新设计取舍（2026-09-15）

1. **继任让位的可见边界**：retiring provider 的绑定可在其逆操作跑完前被继任者接管。若旧组件的逆操作在清理时读取自己提供的键（代码库中无任何此类用法，亦未见文档约定），它看到的将是继任者的值。接管本身不发专用事件——消费方侧照常产生 unload/load 生命周期事件流，判定足够可观测。
2. **逆护栏 = 放弃悬挂获取的恢复**：reaper 放行后，悬挂逆操作对应的获取副作用可能泄漏（例如未关闭的连接）——这是响亮（taint + inverses 事件）且有界的选择，对照旧行为"泄漏整个关停流程"（`root.dispose()` 永挂）严格更优。两个护栏（dependents 等待 / 自有逆等待）默认同预算，在"provider 强卸触发 dependent 卸载"的级联场景会同刻竞速——任一路径先触发都是合法解楔且双方均有信号；需要钉死 provider-force 路径的测试/部署可用新旋钮 `unloadInverseGuardTimeoutMs`（默认 = `unloadGuardTimeoutMs`）拆分预算。`runAccumulated` 语义微调为捕获数组引用（正常路径行为不变，detach 后僵尸 drain 与新代际隔离）。
3. **keepalive alive 接缝的严度选择**：`isCurrent` 在 LOADING/ACTIVE 之外一律为假，故撤退窗（含 waitDependents 阶段）内完成的在途 job 也跳过簿记——新代际有自己的调度会重跑，丢弃一次陈旧结果是正确保守方向。

## 6. REDIAG 复核轮(2026-09-16):选择性强硬化三车道 + 差量 mutation

> 性质:对本轮全部修复的独立复核。A=重验,B=选择性强硬化(B1 fast-check PBT / B2 fiber 转换覆盖 census / B3 Stryker 差量 mutation),C=归因纪律(每条幸存 mutant 先归因再处置)。原始证据:`reports/mutation/mutation.json`、`tests/helpers/transition-census.ts` 可复跑、progress 日志。

- **A 重验 ✅**:全套 477 pass(B1 后)/6 skip(env)/0 fail,smoke 7,typecheck 净;第一轮报告数字复核无污染。
- **B1 PBT ✅**:`tests/runtime-pbt.test.ts` 4 性质(代际守卫 wrap⟺活代际、热替换继任无 FAILED 且终值可见、board 模型基状态机+写透水合等价、compileConfig 接受⟺无环[Kahn 独立 oracle])+4 阴性对照;初跑 2 红均归因 oracle 弱(非被测缺陷)已修;fast-check@4.10.0 入 devDeps。
- **B2 转换覆盖 census ✅**:`tests/helpers/transition-tap-preload.ts`(共享 Emitter 原型 tap)+ `transition-census.ts`(可复跑 runner,零触发弧/非法弧即 exit 1)。477 bench 下 2179 事件/57 fiber:**8/8 合法弧全触发=100% 转换覆盖**,零触发弧 0,非法弧 0(FAILED→INACTIVE 仅 reset 用例、UNLOADING→LOADING 为原地重载,均合法)。G3/G4 当年的盲区类在迁移矩阵维度闭合。
- **B3 Stryker 差量 mutation:62.03% → 处置 → 88.51%(终态)**
  - 口径:全文件级首跑 14.58% 已归因 **metric 失准**(口径错:行为面多走 env-skip 既定决策,bench 测的是 bench 不是修复);改 `git diff -U0` 精确 hunk(本批修复全部插入行,24-25 段)+ union bench(12 行为文件+cookie 两件套+PBT)的**差量口径**,才是对"本批修复"的诚实度量。
  - 差量首跑 62.03%(79 mutant:47 杀/2 超时/30 open)。30 open 逐条归因后:**杀 20**(12 组,全部先手工植变异验红、新断言转绿;新增 6 测试 + main.ts 抽 `logRuntimeEvent`→`src/runtime-log.ts` 纯移动零行为变更),**存 10**(逐条归因见下)。终跑 87 mutant(范围扩至 runtime-log 全分支):**75 杀 + 2 超时,幸存 10,score 88.51%**;cookie-keepalive/idol-bbq/runtime-log 三件 100%。
  - **终态幸存 10 条归因**(复核轮审定,无"等价"美化):
    | mutant | 归因 | 理由 |
    |---|---|---|
    | crawler.ts ×6(:342/:344 × OptionalChaining/ArrowFunction/StringLiteral 'apply') | **oracle 弱 + 可达性债** | 逃逸路径=簿记层自身故障(driver 错误已被 round 内分类 catch,不外逸);无故障注入缝;撤退窗 tick 需"卸载等待窗×到期 tick"双重时序控制,flaky 风险高;:344 即时调用恒 current 实际不可达;即使触发,失败模式=进程级响亮异常而非静默错账 |
    | runtime.ts :544('timeout' 占位串→"") | **字面等价** | winner 的唯一消费点是比较 `winner === 'drained'`;timer 侧 resolve 的占位值从不被比较,两分支行为逐点一致 |
    | runtime.ts :547(`if (timer)`→true) | **字面等价** | timer 在 Promise executor 中同步赋值,到达该 if 时恒为真 |
    | runtime.ts :547(→false 与移除 clearTimeout) | **可接受债务** | 差异真实但有界:每卸载至多挂 1 个定时器,寿命≤护栏预算,到期自清,resolve 已 settle 的 promise 零副作用(复核含 GC 追问:闭包有界释放);bun 无用户态定时器存量 API,探针成本/收益失衡 |
  - **90% 档判定:客观不可达,给真实分数 88.51%**。剩余 10 条=2 字面等价(构造上不可杀)+2 无 API 可观测+6 需新增生产接缝纯为杀 mutant(负 ROI,违反不投机重构边界)。不降档静默。
  - **+1 复核轮**:对等价类抽查复审——crawler 6 从初判"等价"**改标**"oracle 弱/可达性债"(差异真实:响亮 crash vs 静默跳过);:544/:547true 的等价论证复核成立。
- **mutation-hardening 新增测试**(全部先红后绿,红=手工植入对应 mutant 单文件验红):fiber-windows +1(迟醒僵尸 drain 不可窃取继任代际逆+新代际 drain 零污染,杀 detach×3)、lifecycle +1(root 属主冲突抛专用错误而非 TypeError,杀 writeEntry×2)、observability +2(dependents phase 钉住;logRuntimeEvent 三分支渲染钉住,杀 phase×1+runtime-log×16)、import +1(processor-formatter 无 target 回退 to:[],杀 idol×2 之二;warning 全文钉住在原用例上扩断言)、cookie-guard +2(②d 服务层陈旧失败不污染健康持久值;②e 组件 wiring 层 alive=fiber.isCurrent 钉住,杀 ck×2)。
- **终验**:bun test **483 pass / 6 skip(env 不变)/ 0 fail**,smoke 7 pass,typecheck 净。本批新发现 bug 数:0(2 初红均为 oracle 弱,非被测缺陷)。
