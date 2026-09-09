# 设计文档：handoff 换窗

本文件记录**已定/未定**的设计决策及其证据。改行为时同一提交内更新本文件。

上游调研全文：`%USERPROFILE%\.dsh\codex-context-management-report.md`（83 KB，含全部 PR/issue/源码引用）。

---

## 0. 目标与非目标

**目标**：在 DSH 里复刻 Codex 的 `features.context_management.experimental_mode` 语义——预算提示、模型主动换窗、换窗替代摘要——并修掉它的已知缺口（#43335：换窗后第一请求无任务状态）。

**非目标**：
- 不替换 DSH 已有的 `compaction-basic`（压力压缩仍由它负责），除非部署显式把本插件的行挂进 `compaction` realm。
- 不仿 Codex 的"中途换窗连活跃 tool output 一起丢"（DSH 的 seam 禁止不平衡切点）。
- 不做 memories（跨会话自动记忆）——那是 Codex 另一条独立线（`Feature::Memories` / Chronicle）。

---

## 1. 已定的决策

### D1. 记账口径与 Codex 对齐

```text
usable    = floor(cw × effectiveContextWindowPercent / 100)   // 95
limit     = min(configuredLimit, floor(cw × autoCompactTokenLimitRatio))  // 90% 硬钳制
charged   = usedTokens − baselinePrefillTokens                 // body_after_prefix
threshold = min(limit + fallbackBufferTokens, usable)
```

证据：`codex-rs/protocol/src/config_types.rs` 的 `AutoCompactTokenLimitScope { Total(default), BodyAfterPrefix }`；`auto_compact_window.rs` 的 `prefill_input_tokens`（`ServerObserved` 优先于 `Estimated`，注释明确 "It is not the growth itself"）；commit `40de788c` 引入的 90% 钳制至今仍在。

实现：`src/budget.ts`（纯函数）、`src/window-state.ts`（世代 + 基线）。

### D2. 提示是"低频、幂等"的，不是每轮

Codex：开窗时发完整提示（含窗口 id），之后只在消耗跨过 25/50/75% 时各发一次（`TOKEN_BUDGET_USAGE_THRESHOLDS: [25, 50, 75]`，`claim_token_budget_reminder` 每窗口每档一次）。理由：每轮注入会改写请求前缀，摧毁 prompt cache。

实现：`src/emission.ts` 的 `NoticeThrottle`。

### D3. `new_context` 只置标志，不立即换窗

Codex：`invocation.session.request_new_context().await` 只置标志；`run_turn` 采样后 `take_new_context_window_request()`，与自动压缩共用同一条 rollover 路径。

实现：`SessionRuntime.resetRequested`，在下一个 `agent/pre-step` 消费。这同时满足 D4。

### D4. 换窗只能落在 tool-pairing 平衡的边界

DSH 的 `CompactionEngine.compactRegion` 契约要求两侧边界 balanced（`toolPairingBalancedBefore/After`），不允许切穿悬空的 tool call。因此：

- 在工具调用内不换窗（与 Codex 一致）；
- 在 pre-step 换窗，并**先校验整面是否平衡**，不平衡则把请求退回、下个边界再试。

**这是与 Codex 最大的语义差异**：Codex 的 mid-turn 重置会丢掉已完成的 `function_call_output`，DSH 契约不允许，也不应该允许（那会让 assistant tool call 悬空）。

### D5. 换窗事务委托给 seam，不自己写 surface

`resetMode: 'seam-region'` 调用 `ctx.compaction.compactRegion(firstSeq, lastSeq, agent, signal)`：后端拥有 bracket 锁、`compaction/*` 事件、checkpoint 标记与影子价记账，本插件不直接 `session.append`。好处是 replay 确定性、事件兼容、与 `/compact` 一致。

`ctx.get('compaction')` 缺失时**告警并丢弃**，不退化为静默改历史。

### D6. 注入通道用 `agent/pre-step` 决策

DSH 的请求在 LLM 边界 deep-frozen（`markAgentLoopRequest`），listener 只能读。模型可见上下文只能走 `agent/pre-step` 的 `messages`、`agent.inject()` 或已注册的 prompt 段。本插件用 `agent/pre-step` 返回 `createUserMessage({source: {kind:'plugin', form:'snapshot'}})`——与 shipped 的 `dsh-time-context` 同一模式。

**与 Codex 的差异**：Codex 用 developer 角色；DSH 没有 developer 角色，落盘为 user 角色的 plugin snapshot。这是已知的、有意的偏差。

### D7. 默认关闭

`enabled: false`。插件的 bundle patch 只插入一行，装完不改行为。

### D8. `handoff` 是**无摘要**换窗，自己写 surface 替换（U1 拍板后新增）

`handoff` 模式**不调用 `ctx.compaction`**：`CompactionEngine.compactRegion` 在 `compaction-basic` 里总是先跑一次模型摘要（`regionDependencies().summarize`），而"换窗"存在的意义恰恰是省掉那次调用。因此 `handoff` 自己写替换（`src/replace.ts`）：

```text
session.append('compaction/prune', { shadowedRange, shadowedSeqs, shadowedTokenCount })
session.append('user/message', checkpoint, { surfaceOp: {op:'replace', start, end}, sourceEventSeqs: shadowed })
```

两个协议细节是必须的，不是可选的：

1. **`compaction/prune` 影子价**：token meter 的 fold 规则是"没有 armed claim 的 replacement 记 0 delta"（`dsh-token-meter/lib/index.js` 的 `_foldEvent`）。不写这条事件，被替换掉的那段会**永远算在预算里**。
2. **同步连续**：两条 append 之间不能有事件插进来，否则影子价会配错替换。

代价（有意接受）：
- 不产生 `compaction/start`/`compaction/summary`/`compaction/end` 事件，所以这一窗口的换窗在 `/compact` 的 UI 与统计里不可见；
- 绕开了 seam 的 bracket 锁，插件自己用 `hasOpenCompaction()`（扫描未配对的 `compaction/start`）做护栏，有未闭合事务时把换窗推迟到下一个边界；
- `seam-region` 模式保留原样（委托 `compactRegion`，会摘要），供"想复用 compaction 后端记账"的部署使用。

**为什么这是对的**：Codex 的换窗实现 `compact_token_budget.rs` 就是跳过模型/服务端摘要、直接装回全新 initial context（报告 §6）。U1 的选项 **b**（换窗时跑一次模型生成摘要）被明确排除出 `handoff`；如果将来要 b，应作为独立的 `resetMode` 加入，而不是混进 handoff。

### D9. U1 = a + c：模板化骨架 + 模型预写 notes

拍板结果（2026-09-09）：

- **a（模板化）**：`src/handoff.ts` 从**现成状态**拼骨架——goal 投影（`objective`/`phase`/`blockedReason`）、未完成的 todos（`todos` 投影，丢弃 `completed`）、最后一条**人类**消息（`source.kind === 'user'`，刻意排除 tool result 与本插件自己的快照）。零模型调用。
- **c（模型预写）**：注册模型可调用的 `notes` 工具（`src/index.ts`），把笔记写进 per-session 缓冲；重置预告文案（`DEFAULT_RESET_REMINDER_TEMPLATE`）里点名要求模型换窗前调用它。
- **两者的缝合点**：notes 随检查点写入新窗口，写入后清空缓冲——否则每个窗口都重发同一批笔记，越换越胖（§3 风险清单的"交接内容重复累积"）。
- **持久性**：进程重启会丢内存里的 notes，所以 notes 也**可从日志回读**：`readPriorCheckpointNotes()` 从面上最新的 `<context_handoff>` 里解析 `<notes>` 段，`boundNotes()` 再按 `maxRecoveredNoteChars` 截断。这是 U3 的部分解法，不需要额外的 storage domain。

投影读取是**可选**的：`ctx.sessionProjections` 缺失、键未注册、值畸形或抛错，都只让对应段落消失，绝不让换窗路径抛异常。

---

## 2. 未定的决策（需要在实现 handoff 前拍板）

> **U1 与 U2 已拍板**（见 §1 的 D8/D9）。下面保留原始三候选表作为决策记录。

### U1. 交接内容从哪来？ —— ✅ 已定：**a + c**（见 D9）

三个候选：

| 方案 | 来源 | 代价 | 风险 |
|---|---|---|---|
| a. 模板化 | 从 surface 抽取最近目标/待办（`todo_write` 状态、goal、最后一条 user 消息） | 无模型调用 | 语义弱，可能漏关键约束 |
| b. 模型生成 | 换窗时先跑一次 handoff 摘要调用 | 一次模型调用（正是换窗想省掉的） | 回到摘要压缩的老问题，但**只在换窗时付一次**，而非每轮 |
| c. 模型预写 | 提示里要求模型在换窗前调用 notes 工具写交接 | 无额外调用 | 依赖模型自觉（Codex #43335 的教训） |

**拍板：a + c 混合** —— 模板化骨架保证下限，再提醒模型用 notes 补细节。b 未采纳（见 D8）。

### U2. 交接内容注入到哪？ —— ✅ 已定：**检查点 user 消息**（surface replace）

- 作为新窗口的 checkpoint user 消息（与 seam 的替换语义一致）→ 会被计入后续换窗的"待压缩区"，需要防重复累积。
- 作为 plugin snapshot context（`systemPrompt.context` 或 pre-step 注入）→ 不进 surface，但每次换窗都要重发。

**拍板：checkpoint user 消息**，与 seam 的替换形状一致、replay 可见。防重复累积由 D9 处理：notes 写入后清空缓冲，且只从面上**最新**的一个检查点回读。

### U3. 窗口基线的持久化

`baselinePrefillTokens` 目前只在内存（`Map<sessionId, SessionRuntime>`）。进程重启后会话恢复（`session/disposed` 之外还有 resume 路径），基线会丢，导致 `body_after_prefix` 退化为 `total`。

候选：写进 session log 的自定义事件（declaration merging `SessionEventMap`）、或 storage domain。需要先确认 resume 时的重放语义。

### U4. 是否接管压力压缩

若插件挂在 `compaction` realm 并替换 `compaction-basic`，压力触发也会走"换窗"。这需要：
- 实现 `CompactionEngine` 三个抽象方法（而不只是 `compactRegion`）；
- 决定 `compactIfNeeded` 在压力下的行为（换窗 vs 摘要）；
- 处理 `modelPolicies` 这类 per-route 覆盖。

倾向：**v1 不接管**，保持 `compaction-basic` 负责压力，本插件只负责模型主动换窗 + 提示。

### U5. UI

已有 `ContextMeter`（`dsh-client-ui-conversation`）由 `contextPressure` / `contextBreakdown` 投影驱动。窗口序号与剩余量可以：
- 注册自己的 `ProjectionDefinition` + client slot；或
- 复用现有 meter，仅把 `<context_window>` 文本换掉。

需要先确认浏览器半的打包链路（`dsh.client` + `./client` 导出）与 `dsh-client-modules` 的扫描约定。

---

## 3. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| token meter 启发式低估 CJK | 阈值偏晚，换窗来不及 | 阈值保守（95%/90% 已留头寸）；优先用 provider usage anchor |
| 模型未声明 `contextWindow` | 提示完全关闭 | 启动告警一次；文档要求先补 `settings.yaml` 的 `contextWindow` |
| host 平面无 `ctx.compaction` | `seam-region` 换窗请求被丢弃 | 告警 + 文档写明挂载位置。`handoff` 模式不需要后端 |
| 换窗后模型重新探索 | 总 token 未必下降 | 文档明示这是"可观测的失败优于静默的失败"，不是省钱手段 |
| 交接内容重复累积 | 新窗口越换越胖 | ✅ 已缓解：notes 写入后清空；只从最新检查点回读；notes/todos/请求文本都有上限 |
| `handoff` 自写 surface 与并发压缩冲突 | 两条替换交错 | ✅ 已缓解：`hasOpenCompaction()` 护栏，有未闭合事务时推迟到下一个边界 |
| `handoff` 换窗在 `/compact` UI 中不可见 | 用户看不出发生过换窗 | 接受（D8）；日志里有 `handoff: window N -> M` 一行 |

---

## 4. 验收标准（v1）

1. `pnpm check` 全绿。
2. 真机挂载：`dsh plugin --profile web add` + headless 渲染不崩。
3. 长会话里消耗跨过阈值时，模型可见文本按 D2 出现，且**同一档不重复**。
4. `new_context` 调用后，下一次请求的历史**不含**旧窗口的 user/assistant 消息，且**含**交接检查点。
5. 悬空 tool call 时调用 `new_context`，换窗被推迟到下一个边界且**不破坏 tool 配对**。
6. replay 该会话日志，`deriveMessages()` 与当时一致。
7. `handoff` 换窗**不产生任何模型调用**，且被替换区段的 token 从预算中扣除（`compaction/prune` 影子价）。
8. 换窗后的检查点含 goal / 未完成 todos / 模型 notes / 最后一条人类请求（各自缺失时对应段落消失，不报错）。
