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

---

## 2. 未定的决策（需要在实现 handoff 前拍板）

### U1. 交接内容从哪来？

三个候选：

| 方案 | 来源 | 代价 | 风险 |
|---|---|---|---|
| a. 模板化 | 从 surface 抽取最近目标/待办（`todo_write` 状态、goal、最后一条 user 消息） | 无模型调用 | 语义弱，可能漏关键约束 |
| b. 模型生成 | 换窗时先跑一次 handoff 摘要调用 | 一次模型调用（正是换窗想省掉的） | 回到摘要压缩的老问题，但**只在换窗时付一次**，而非每轮 |
| c. 模型预写 | 提示里要求模型在换窗前调用 notes 工具写交接 | 无额外调用 | 依赖模型自觉（Codex #43335 的教训） |

倾向 **a + c 混合**：模板化骨架（目标/已完成/下一步）+ 提醒模型用 notes 补细节。b 作为可选 `resetMode: 'handoff-summarize'`。

**人话版（给用户决策用）**：换窗之后，新窗口里得有点东西让模型知道"我在干嘛"。这份东西从哪来，三种：

- **a. 自动拼** —— 不花模型调用，从现成的状态里凑（待办列表、目标、最后一条用户消息）。便宜、稳定，但可能漏关键约束。
- **b. 让它写** —— 换窗前多花一次模型调用，专门写一份交接。质量最好，但这就是压缩模式的老成本，只是从"每轮"变成"每次换窗"。
- **c. 让它先写** —— 什么都不做，靠提示词要求模型在换窗前自己调 notes 写下来。零成本，但**依赖模型自觉**——Codex 现在的换窗正是这条路，结果就是 issue #43335 那个"换窗后第一个请求没有任务状态"。

官方现在的换窗 = c（翻车）；官方压缩模式 = b 的变体（每次都付）。本项目倾向 **a + c**：自动拼骨架保证下限，再提醒模型补细节。

### U2. 交接内容注入到哪？

- 作为新窗口的 checkpoint user 消息（与 seam 的替换语义一致）→ 会被计入后续换窗的"待压缩区"，需要防重复累积。
- 作为 plugin snapshot context（`systemPrompt.context` 或 pre-step 注入）→ 不进 surface，但每次换窗都要重发。

倾向：**checkpoint user 消息**，因为 seam 的替换就是这个形状，且 replay 可见。

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
| host 平面无 `ctx.compaction` | 换窗请求被丢弃 | 告警 + 文档写明挂载位置 |
| 换窗后模型重新探索 | 总 token 未必下降 | 文档明示这是"可观测的失败优于静默的失败"，不是省钱手段 |
| 交接内容重复累积 | 新窗口越换越胖 | U2 需给出防重复策略 |

---

## 4. 验收标准（v1）

1. `pnpm check` 全绿。
2. 真机挂载：`dsh plugin --profile web add` + headless 渲染不崩。
3. 长会话里消耗跨过阈值时，模型可见文本按 D2 出现，且**同一档不重复**。
4. `new_context` 调用后，下一次请求的历史**不含**旧窗口的 user/assistant 消息，且**含**交接检查点。
5. 悬空 tool call 时调用 `new_context`，换窗被推迟到下一个边界且**不破坏 tool 配对**。
6. replay 该会话日志，`deriveMessages()` 与当时一致。
