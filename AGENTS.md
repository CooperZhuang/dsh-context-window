# dsh-context-window — AGENTS.md

> **Picking this up cold? Read `docs/handoff.md` first** — it is self-contained:
> current state, environment facts, the mounting constraint, the API map with
> evidence locations, the trap list, and the prioritized next steps.

Working notes for agents editing this repository. The user-facing documentation
is `README.md`; the design rationale is `docs/design.md`.

## What this repository is

A DSH (DeepSeek Harness) plugin package that reimplements Codex's experimental
"context management" model: a token-budget notice, a model-facing
`new_context` tool, and a window reset that replaces summary compaction.

It is a **bundle**: `package.json` declares `dsh.bundle.patch`, pointing at
`cordis.patch.yml`, which is the layer DSH merges when the package is installed
through `dsh plugin --profile <name> add dsh-context-window`.

## Hard constraints (do not "fix" these away)

- **Host plane vs agent realm.** `ctx.compaction` is realm-scoped: the shipped
  Web profile disables the host-plane compaction rows and the `standard` agent
  preset mounts `compaction-basic` inside `isolate: { compaction: true }`.
  `tokenMeter`, `tools`, and `systemPrompt` stay on the host plane. A plugin row
  inserted by this bundle therefore CAN contribute the notice and the tool, but
  CANNOT become the agent's compaction backend unless it is mounted inside that
  realm. See the header of `cordis.patch.yml`.
- **No request rewriting.** The agent loop's request is deep-frozen and tagged
  (`markAgentLoopRequest`); `llm/stream` listeners read it, never rewrite it.
  Model-visible context goes through `agent/pre-step` decisions, `agent.inject`,
  or registered prompt sections.
- **Balanced cuts only.** The compaction seam refuses a range whose edges cross
  an unanswered tool call. A reset is deferred to the next boundary rather than
  cutting through a live tool call.
- **One `ctx.compaction` per context.** Two backends cannot coexist in one
  realm; replacing `compaction-basic` means disabling its row.
- **The token meter is a heuristic** (four characters per token). CJK and JSON
  schemas are underpriced. Never present its output as exact billing data.

## Conventions

- TypeScript, ESM, `verbatimModuleSyntax` — type-only imports use `import type`.
- Comments explain *why*, not *what*; the DSH packages in `node_modules` are the
  style reference.
- `pnpm check` runs the same gates as CI: typecheck → lint → build → test.
- `lib/` is generated and gitignored; never commit it.
- Every model-visible string lives in `src/notice.ts` so it can be reviewed in
  one place.

## Where the design decisions live

`docs/design.md` records the open decisions with their evidence. If you change a
behaviour that a decision describes, update that file in the same commit.
