# 交接文档 — dsh-context-window

> **给接手的人（或下一个会话的 agent）**：本文件是自包含的。你不需要之前的对话记录。
> 最后更新：2026-09-09，`handoff` 模式已实现（82 个单测绿，`pnpm check` 全绿）。

---

## 0. 一句话现状

仓库骨架已建好、已发布、CI 通过、**82 个单测绿**。预算记账与提示**已实现并可用**；**`handoff` 与 `seam-region` 两种换窗都已实现**。插件默认 `enabled: false`，所以现在装上不会改变任何行为。

**U1/U2 已拍板**（a + c 混合 / 检查点 user 消息，见 `docs/design.md` §1 D8–D9），阻塞项解除。

**当前卡在**：真机挂载冒烟（需要用户同意改他正在用的 web profile），以及 §7 里剩下的第 3 项（`settings.yaml` 补 `contextWindow`）。

---

## 0.5 在新工作区接上（用户的目标）

用户会**在 DSH 里切换工作区**，把这件事接到新会话继续。接续步骤：

1. **新会话的工作区选 `<REPO_ROOT>`**。
   为什么这就够了：`dsh-agent-instructions` 会自动读取工作区根目录的 `AGENTS.md`，而 `AGENTS.md` 顶部第一句就指向本文件。**选对工作区 = 交接自动生效**，不需要用户粘贴任何背景。
2. 用户如果只贴一句话，可以用这个：
   ```
   读 docs/handoff.md 和 docs/design.md，按 §7 的下一步执行。
   ```
3. 新会话开工前的两件事：
   - `cd <REPO_ROOT> && pnpm check` —— 确认基线还是绿的（应 **82** 测试通过）；
   - 读 `docs/design.md` §1 的 D1–D9 与 §7 的下一步。
4. **不要**在用户明确同意前执行 `dsh plugin --profile web add dsh-context-window`：那会改他正在用的 web profile。

---

## 1. 这个项目要做什么

DSH（DeepSeek Harness）插件，复刻 Codex 从 0.153.0 起的**实验性上下文管理**：

- 不再"把上下文压缩成摘要"，而是**丢掉整个窗口、装回一份全新初始上下文**（换窗）；
- 配套三件套：模型可见的 token 预算提示、模型可调用的 `new_context` 工具、跨窗口的 notes/history 接续；
- 我们的改进目标：Codex 的换窗路径有已知缺陷（issue #43335：换窗后第一个请求**完全没有任务状态**），所以本项目要做 **handoff 换窗**——换窗时主动写入交接检查点。

**证据来源**：完整调研报告在 `%USERPROFILE%\.dsh\codex-context-management-report.md`（83 KB，含 50+ 源码路径、10 条 PR/commit、15 条 issue、30+ 官方文档链接）。本文件只摘结论。

---

## 2. 仓库与环境事实

| 项 | 值 |
|---|---|
| GitHub | https://github.com/CooperZhuang/dsh-context-window （public） |
| 本地 | `<REPO_ROOT>` |
| 分支 / 提交 | `main` / `ecde650` |
| CI | GitHub Actions，绿（typecheck → lint → test → build） |
| 包名 | `dsh-context-window`，版本 `0.0.1` |
| Node | 本地 v24.16.0；CI 用 22 |
| pnpm | 12.3.4（`packageManager` 已钉） |
| 构建 | `tsc -p tsconfig.build.json` 出 `lib/types/*.d.ts` + `tsdown` 出 `lib/index.js` |
| DSH 依赖 | **`0.1.2-rc.1`**（npm `next` dist-tag） |
| DSH CLI | `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`（0.1.2-rc.1） |
| DSH 包源码 | 同目录 `node_modules\@deepseek-ai\`（约 200 个包，每个带 `lib/*.js` + `lib/types/*.d.ts` + `README.md`） |
| 用户 profile | `%USERPROFILE%\.dsh\profiles\web`（bundles: `dsh-base`, `dsh-web-app`, `dshmarket`, `dsh-better-sidebar`；`patchReload: live`） |
| 用户设置 | `%USERPROFILE%\.dsh\settings.yaml` |

### ⚠️ 陷阱清单（都是踩过的）

1. **`npm view <pkg> version` 会骗你**：`@deepseek-ai/dsh-*` 的 `latest` 是旧的 `0.0.1-rc.x`，正确的版本在 `next` = `0.1.2-rc.1`。装依赖必须钉 `0.1.2-rc.1`。
2. **`settings.yaml` 里选用的模型没有 `contextWindow`**：`<provider-model-id>` 未声明窗口，会回落 adapter 默认 `1e6`。**不先补这个，提示和阈值永远几乎不会触发。**
3. **`ctx.compaction` 是按 realm 隔离的**（见 §4），host 平面挂载拿不到它。
4. **seam 强制 tool-pairing 平衡**：不允许切穿悬空的 tool call，所以换窗只能落在 step 边界。
5. **TS/构建细节**：schemastery 的字面量联合要写 `z.union([...] as const)`；`ctx.llm.resolveModelInfo()` 是 **async**；`session.surface.nodes` 是 `readonly SessionSeq[]`（不是对象数组）；`session/disposed` 的回调**直接收 `Session`**（不是 payload）；tsdown 要显式 `outExtensions: () => ({ js: '.js' })` 否则产出 `.mjs`。

---

## 3. 已完成 vs 未完成

### ✅ 已实现（`src/`，82 个单测覆盖）

| 文件 | 内容 |
|---|---|
| `src/budget.ts` | `usable = floor(cw×95%)`、`limit = min(配置, floor(cw×90%))`、`charged = used − baseline`（body_after_prefix）、`threshold = min(limit + buffer, usable)`；全部纯函数，越界即抛 |
| `src/window-state.ts` | 窗口世代：ordinal + first/previous/current id 链；`observePrefill`（服务端观测）**优先于**`estimatePrefill` 且不被覆盖；`startNext()` 清基线 |
| `src/notice.ts` | `<context_window>` 提示、换窗预告（默认文案 = Codex 原文 + notes 工具一句）、`<context_handoff>` 检查点渲染、`extractNotesSection` 回读、模板校验 |
| `src/emission.ts` | `NoticeThrottle`：消耗跨过 25/50/75% 各发一次，每窗口重置 |
| `src/config.ts` | schemastery schema + `assertConfig` 加载期 fail-loud（含 notes/handoff 上限） |
| `src/handoff.ts` | **U1 option a**：从 goal/todos 投影 + 最后一条人类消息拼骨架；`NotesBuffer`（option c 的容器）；`readPriorCheckpointNotes` 从日志回读 notes |
| `src/replace.ts` | **无摘要换窗**：`compaction/prune` 影子价 + `user/message` 整面 `replace`；`hasOpenCompaction` 并发护栏 |
| `src/index.ts` | 接线：懒解析服务、`agent/pre-step` 注入提示与预告、`new_context` 工具（置标志）、`notes` 工具、`executeReset` 分派两种模式 |

### ⛔ 未实现

- history 工具（跨窗口检索；notes 已实现）。
- 浏览器半（UI 显示窗口序号/剩余量）。
- 真机挂载冒烟（`dsh plugin add` + headless 渲染）。
- 基线持久化（`baselinePrefillTokens` 现在只在内存 `Map<sessionId, SessionRuntime>`；notes 已能从日志回读，基线还不行）。

---

## 4. 挂载约束（最容易做错的地方）

`ctx.compaction` 是 **realm 隔离**的：

```yaml
# dsh-agent-presets/presets/standard/agent.cordis.yml:137-155
- id: compaction
  name: cordis:group
  isolate: { compaction: true, toolResultPruner: true }
  config:
    - id: compaction-basic
    - id: command-compact
    - id: tool-result-pruner
```

而 `dsh-web-app/cordis.patch.yml:387-394` 把 host 平面这三个行 `disabled: true`。
`tokenMeter` / `tools` / `systemPrompt` 刻意留在 **host 平面**（preset 注释 `:131-136` 说明了理由）。

| 需求 | 挂载位置 | 结果 |
|---|---|---|
| 只要提示 + `new_context` 工具 | profile（host 平面，即本仓库 `cordis.patch.yml` 默认行） | ✅ 可用 |
| 接管压缩后端 | agent preset 的 `compaction` realm | ✅ 需把行挂进去（模板见 `cordis.patch.yml` 注释） |
| 两个后端并存 | —— | ❌ 一个 realm 只允许一个 `ctx.compaction` |

host 平面无后端时，`new_context` 请求**告警并丢弃**，不会静默改历史。

---

## 5. 关键 DSH API（含证据位置）

| 用途 | API | 位置 |
|---|---|---|
| 压缩契约 | `CompactionEngine.compactRegion(start, end, agent, signal?)` | `dsh-compaction\lib\types\index.d.ts:75-131` |
| 边界校验 | `toolPairingBalancedBefore/After(session, seq)` | `dsh-compaction\lib\types\tool-pairing.d.ts:16-25` |
| checkpoint 标记 | `compactCheckpointSource` / `isCompactCheckpointSource` | `dsh-compaction\lib\types\checkpoint.d.ts` |
| 计量 | `ctx.tokenMeter.measure(session)` → `{totalTokens, surfaceTokens, baseline{kind,tokens}, nodes[]}` | `dsh-token-meter\lib\types\index.d.ts:45`；`types.d.ts:24-37` |
| 容量 | `await ctx.llm.resolveModelInfo(provider, model)` → `.context?.contextWindow` | `dsh-llm\lib\types\index.d.ts:343` |
| 注入上下文 | `agent/pre-step` waterfall 返回 `{...decision, messages: [...decision.messages, createUserMessage({...})]}` | `dsh-agent\lib\types\runtime-types.d.ts:239-245,50-57` |
| 消息构造 | `createUserMessage({content, source: {kind:'plugin', plugin, form:'snapshot', sections}})` | `dsh-llm\lib\types\message.d.ts:171` |
| 注册工具 | `ctx.tools.register(defineTool({name, description, parameters, output, execute}))` | `dsh-tools\lib\types\index.d.ts:602`；`schema.d.ts:176-208` |
| 读投影（可选） | `ctx.sessionProjections.stateOf(session, 'todos' \| 'goal')` | `dsh-session-projection\lib\types\index.d.ts:175`；键声明在 `dsh-tool-todo\lib\types\types.d.ts:34-46`、`dsh-goal\lib\types\types.d.ts:94-107` |
| 影子价协议 | `compaction/prune`（无 armed claim 的 replace 记 0 delta） | `dsh-compaction\lib\types\types.d.ts:79-98`；fold 规则 `dsh-token-meter\lib\index.js` 的 `_foldEvent` |
| 换窗世代 | `AutoCompactWindow` 的语义参考 | 报告 §4 |
| 直接改历史（`handoff` 用） | `session.append('user/message', msg, {surfaceOp:{op:'replace',start,end}, sourceEventSeqs})` | `dsh-session\lib\types\types.d.ts:390-421`；`session.append` 签名 `index.d.ts:198-233` |

**请求不可改写**：loop 构造的请求 deep-frozen 且带 `markAgentLoopRequest`，`llm/stream` listener 只能读（`dsh-llm\lib\types\index.d.ts:35-41`）。模型可见内容只能走 `agent/pre-step` / `agent.inject()` / 已注册的 prompt 段。

---

## 6. Codex 侧事实（对齐用，均已核实到 diff/源码）

| 事实 | 值 |
|---|---|
| 可用窗口 | `usable = cw × 95%`（`effective_context_window_percent` 默认 95） |
| 自动阈值 | `min(配置值, cw × 90%)`，用户值被**硬钳制**到 90% |
| 触发条件 | `charged ≥ min(limit + fallback_buffer, usable)` 或 `active ≥ usable` |
| `fallback_buffer` 默认 | 8000 |
| 提示阈值 | 开窗一次 + 消耗 25/50/75% 各一次（`TOKEN_BUDGET_USAGE_THRESHOLDS`） |
| 提示角色 | developer（DSH 无此角色 → 本插件用 plugin snapshot user 消息） |
| `new_context` | 只置标志，`run_turn` 采样后 `take_new_context_window_request()` 翻转 |
| 换窗实现 | `compact_token_budget.rs`：**跳过模型/服务端摘要**，装回全新 initial context |
| 开关 | `features.context_management.experimental_mode = true`（`UnderDevelopment`，默认 off，需 ChatGPT Plus/Pro/ProLite + codex backend） |
| 已知缺陷 | issue #43335：换窗后第一个请求无任务状态（notes 未注入）；issue #14347：多轮摘要质量衰减 |
| 预告文案 | "Your context window is nearly exhausted (only {n_remaining} tokens remaining) ... but notes and history items will be persistent across windows." |

---

## 7. 下一步（按优先级）

1. ~~拍板 U1~~ ✅ 已定（a + c，见 `docs/design.md` D9）。
2. ~~实现 `resetMode: 'handoff'`~~ ✅ 已实现（无摘要换窗，见 D8）。
3. **补 `settings.yaml` 的 `contextWindow`**（或在插件里对缺失窗口做更友好的降级）——否则真机验证看不到任何提示。**注意：这要改用户设置，先问。**
4. **真机挂载冒烟**：`dsh plugin --profile web add dsh-context-window` → 设 `enabled: true` → 观察提示是否出现、`new_context` / `notes` 是否可用、换窗后新窗口里是否有 `<context_handoff>`。⚠️ 这会改用户正在用的 web profile，**动手前先问用户**。
5. **history 工具**（跨窗口接续的第二半；notes 已完成）。
6. 基线持久化（U3 剩余部分；notes 已能回读，基线还只在内存）。
7. 浏览器半：在已有 `ContextMeter` 上加窗口序号/剩余量。

---

## 8. 命令速查

```powershell
# 开发门禁（= CI）
cd <REPO_ROOT>
pnpm install
pnpm check          # typecheck → lint → build → test

# 单跑
pnpm typecheck ; pnpm lint ; pnpm test ; pnpm build

# 看 DSH 源码（只读）
#   包实现： %APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<pkg>\
#   组合层： dsh-base\cordis.patch.yml、dsh-web-app\cordis.patch.yml、dsh-agent-presets\presets\standard\agent.cordis.yml

# 挂载（改用户 profile，先征求同意）
dsh plugin --profile web add dsh-context-window
```

---

## 9. 交接清单

- [x] 仓库已发布、CI 绿、82 测试通过
- [x] 挂载约束与陷阱已写入 `cordis.patch.yml` 注释、`AGENTS.md`、本文件
- [x] 设计决策（已定 D1–D9 / 未定 U3–U5）记录在 `docs/design.md`
- [x] 上游调研全文在 `%USERPROFILE%\.dsh\codex-context-management-report.md`
- [x] 交接文档写好并被 `AGENTS.md` / `README.md` 指向
- [x] 用户决定：在 DSH 里切换工作区，把本任务接到新会话继续（接续步骤见 §0.5）
- [x] **U1 拍板：a + c 混合**
- [x] `handoff` 模式实现（无摘要换窗 + 模板检查点 + notes 工具）
- [ ] 真机挂载验证
- [ ] 基线持久化（U3 剩余）
