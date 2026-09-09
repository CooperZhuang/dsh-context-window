# dsh-context-window

[English](README_EN.md) | 中文

DSH 插件：复刻 Codex 最新的**上下文窗口管理**模型 —— token 预算提示、模型可调用的 `new_context`、以及**用换窗替代摘要压缩**。

> **状态：v0（0.0.1）**
> 预算记账、窗口世代状态、提示文本与阈值节流**已实现并有 82 个单测**；
> `resetMode: 'seam-region'` 委托 `ctx.compaction.compactRegion` 执行整面替换（会摘要）；
> `resetMode: 'handoff'` **已实现**——不跑摘要，直接换窗并写入交接检查点（目标 / 未完成待办 / 模型笔记 / 最后一条人类请求）。
> 插件默认 `enabled: false`，装上不会改变任何行为。

---

## 为什么要有这个插件

Codex 从 0.153.0 起（PR [#42385](https://github.com/openai/codex/pull/42385)）加入了一条与"摘要压缩"并列的路径。官方配置文档的原话是：

> Rather than repeatedly compressing context into a single summary, it uses **notes and searchable history** to preserve accumulated details.

关键实现（PR [#29743](https://github.com/openai/codex/pull/29743)）的注释：

> Token-budget compaction **skips model/server summarization** and installs a **fresh context window** instead.

也就是说：上下文将满时不再写摘要，而是**丢掉整个窗口**，只装回一份全新的初始上下文。这套设计由三件套组成：

| 组件 | Codex | 本插件 |
|---|---|---|
| 预算提示 | `<token_budget>` / `<context_window>` developer 消息，开窗一次 + 消耗 25/50/75% 各一次 | ✅ `src/notice.ts` + `src/emission.ts` |
| 模型主动换窗 | `new_context` 工具（置标志，下一轮翻转） | ✅ `src/index.ts`（同名工具，同样"置标志"语义） |
| 记账口径 | `usable = cw × 95%`，`limit = min(配置, cw × 90%)`，`body_after_prefix` | ✅ `src/budget.ts` |
| 换窗后接续 | notes / history 工具 + memories 注入 | ✅ `notes` 工具 + `resetMode: 'handoff'`（`history` 未实现） |

**为什么要仿**：摘要压缩是"隐式有损"——模型不知道丢了什么，也没法找回来（Codex issue [#14347](https://github.com/openai/codex/issues/14347) 记录了多轮压缩后的质量衰减）。换窗是"显式重启"——模型知道旧内容还在某处，需要时自己去取。同时省掉每次压缩的模型调用。

**为什么不能照抄**：Codex 自己这条路径现在有坑——issue [#43335](https://github.com/openai/codex/issues/43335) 记录换窗后**第一个请求完全没有任务状态**（notes 没被注入），比经典压缩还差。所以本插件的目标形态是 **handoff 换窗**：换窗时主动把交接内容写进新窗口，而不是指望模型自己想起来写笔记。

---

## 安装

```bash
dsh plugin --profile web add dsh-context-window
```

`package.json` 声明了 `dsh.bundle.patch`，所以这一条命令就会把插件挂进 profile 的 bundle 栈，无需手改 `cordis.patch.yml`。装完默认 `enabled: false`。

### 挂载约束（重要）

`ctx.compaction` 是**按 realm 隔离**的。shipped Web profile 把 host 平面的压缩行显式禁用，改由 `standard` agent preset 在隔离 realm 里挂载：

```yaml
# dsh-agent-presets/presets/standard/agent.cordis.yml
- id: compaction
  name: cordis:group
  isolate: { compaction: true, toolResultPruner: true }
```

而 `tokenMeter` / `tools` / `systemPrompt` 留在 **host 平面**。因此：

| 需求 | 挂载位置 | 结果 |
|---|---|---|
| 提示 + `new_context` + `notes` 工具 | profile（host 平面） | ✅ 可用，`compaction-basic` 继续负责压力压缩 |
| `resetMode: 'handoff'` 无摘要换窗 | profile（host 平面） | ✅ **不需要** `ctx.compaction`：插件自己写整面替换 |
| `resetMode: 'seam-region'` 委托换窗 | agent preset 的 `compaction` realm | ✅ 可替换 `compaction-basic` |
| 两个后端并存 | —— | ❌ 一个 realm 只允许一个 `ctx.compaction` |

`seam-region` 在 host 平面挂载时，`new_context` 请求会因为没有压缩后端而**告警并丢弃**，不会静默改历史。`handoff` 模式没有这个限制。

---

## 配置

在挂载行或 profile 的 `cordis.patch.yml` 里写：

```yaml
- id: context-window
  name: 'dsh-context-window'
  config:
    enabled: true
    resetMode: handoff
    noticeThresholds: [25, 50, 75]
    effectiveContextWindowPercent: 95
    autoCompactTokenLimitRatio: 0.9
    fallbackBufferTokens: 8000
    reminderThresholdTokens: 16000
    bodyAfterPrefix: true
    toolEnabled: true
    toolName: new_context
    notesToolEnabled: true
    notesToolName: notes
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关；关闭时插件不注册任何东西 |
| `resetMode` | `'seam-region'` | `seam-region` = 委托 `compactRegion` 替换整面（会摘要）；`handoff` = **无摘要**换窗 + 写入交接检查点 |
| `noticeEnabled` | `true` | 是否注入窗口提示 |
| `noticeThresholds` | `[25, 50, 75]` | 消耗百分比阈值，每个窗口每档只发一次 |
| `effectiveContextWindowPercent` | `95` | 可用窗口占比（对齐 Codex） |
| `autoCompactTokenLimitRatio` | `0.9` | 对 `configuredLimit` 的硬钳制（对齐 Codex） |
| `configuredLimit` | 未设 | 显式 token 上限，受上一行钳制 |
| `fallbackBufferTokens` | `8000` | 阈值下为下一轮输出预留的空间 |
| `reminderThresholdTokens` | `16000` | 剩余降到此值时发一次换窗预告 |
| `resetReminderTemplate` | Codex 同款文案 + notes 一句 | 必须含 `{n_remaining}`；`{notes_tool}` 会被替换成工具名 |
| `bodyAfterPrefix` | `true` | 只对窗口基线之上的增长计费 |
| `toolEnabled` / `toolName` | `true` / `new_context` | 模型可见的换窗工具 |
| `notesToolEnabled` / `notesToolName` | `true` / `notes` | 模型可见的笔记工具（跨窗口接续） |
| `maxNotes` / `maxNoteChars` | `8` / `500` | 跨窗笔记的条数与单条长度上限 |
| `maxHandoffTodos` | `12` | 检查点里携带的未完成待办上限 |
| `maxHandoffRequestChars` | `2000` | 检查点里携带的最后一条人类请求上限 |
| `maxRecoveredNoteChars` | `2000` | 从日志回读笔记时的总长度上限 |

配置在加载时**失败即报错**：比例越界、`resetMode` 未知、模板缺占位符都会拒绝插件加载。

---

## 模型看到的文本

窗口提示（开窗时带窗口 id 链）：

```text
<context_window>
Current context window 1.
First context window id 0199...
Previous context window id 0199...
Current context window id 0199...
You have 121600 tokens left in this context window.
</context_window>
```

接近耗尽时追加一次预告（默认文案 = Codex 原文 + 一句 notes 提醒）：

```text
Your context window is nearly exhausted (only 14200 tokens remaining) and will be automatically reset for you soon.
Once reset, message items in the current context window will be cleared in the new window, but notes and history items will be persistent across windows.
Before the reset, call the notes tool once to record anything the next window must not lose.
```

`new_context` 工具返回：

```text
A new context window will start without summarizing conversation history.
```

`notes` 工具返回：

```text
Noted (1/8 notes retained for the next window).
```

`resetMode: 'handoff'` 换窗后，新窗口的第一条消息就是检查点（缺失的段落直接省略）：

```text
<context_handoff>
Context window 1 (id 0199…) ended; this is context window 2 (id 0199…).
The messages of the previous window are gone. The state below was carried over verbatim.

<objective phase="active">
修复换窗后没有任务状态的问题
</objective>

<remaining_work>
- [~] 补 history 工具
- [ ] 真机挂载冒烟
</remaining_work>

<notes>
- seam 禁止不平衡切点，换窗只能落在 step 边界
</notes>

<last_human_request>
继续之前的工作
</last_human_request>
</context_handoff>
```

---

## 已知限制

- **host 平面无法接管压缩后端**（见上表）。`seam-region` 要真换窗，必须把行挂进 agent preset 的 `compaction` realm；`handoff` **不需要**后端，host 平面即可换窗。
- **换窗只能落在 step 边界**：DSH 的压缩 seam 强制 tool-pairing 平衡，不允许切穿一个还在飞的工具调用；Codex 允许中途换窗并丢掉活跃的 tool output，本插件**不仿这一点**。
- **token meter 是启发式的**（4 字符/token），CJK 与 JSON schema 会被低估；阈值会偏晚触发。它只复用 envelope 完全一致的服务端用量。
- **模型声明的窗口缺失时不工作**：当前 `settings.yaml` 里选用的模型没写 `contextWindow` 时，会回落 adapter 默认值；如果 adapter 也不声明，插件会告警并保持关闭提示。
- **`handoff` 不产生 `compaction/*` 事件**：换窗在 `/compact` 的 UI 与统计里不可见，只在日志里留一行 `handoff: window N -> M`。这是"零模型调用"的代价。
- **基线不持久**：`baselinePrefillTokens` 只在内存，进程重启后 `body_after_prefix` 会退化为 `total`（笔记不受影响，它们能从日志回读）。

## 路线图

1. `history` 工具（按窗口检索历史；`notes` 已实现）。
2. 基线持久化（U3）。
3. 浏览器半：在已有 `ContextMeter` 上显示窗口序号与剩余量。
4. 真实 DSH 挂载冒烟（`dsh plugin add` + headless 渲染）。

## 开发

```bash
pnpm install
pnpm check      # typecheck → lint → build → test
pnpm test       # 82 个单测
```

`lib/` 是构建产物（tsdown + `tsc -p tsconfig.build.json`），不入库。

**接手开发请先读 [`docs/handoff.md`](docs/handoff.md)**（自包含的交接文档：现状、环境事实、挂载约束、API 地图、陷阱清单、下一步）。设计决策见 [`docs/design.md`](docs/design.md)。

## 许可

MIT
