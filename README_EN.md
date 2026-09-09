# dsh-context-window

English | [中文](README.md)

A DSH plugin that reimplements Codex's **context window management** model: a
token-budget notice, a model-facing `new_context` tool, and a window reset that
replaces summary compaction.

> **Status: v0 skeleton (0.0.1).**
> Budget math, window generations, notice text, and threshold throttling are
> implemented and covered by 42 unit tests. `resetMode: 'seam-region'` delegates
> the whole-surface replacement to `ctx.compaction.compactRegion`;
> `resetMode: 'handoff'` is declared and validated but **not implemented**.
> The plugin defaults to `enabled: false`, so mounting it changes nothing.

## Why

Codex 0.153.0 ([PR #42385](https://github.com/openai/codex/pull/42385)) added a
path that sits beside summary compaction. Its config reference says:

> Rather than repeatedly compressing context into a single summary, it uses
> **notes and searchable history** to preserve accumulated details.

The implementation ([PR #29743](https://github.com/openai/codex/pull/29743)) is
blunt about the mechanism:

> Token-budget compaction **skips model/server summarization** and installs a
> **fresh context window** instead.

So when the window fills, the history is dropped rather than summarized, and a
fresh initial context is installed. Summary compaction is lossy and the model
cannot recover what it lost ([issue #14347](https://github.com/openai/codex/issues/14347));
a window reset is an explicit restart the model can reason about — and it costs
no summarization call.

Codex's own reset path is currently incomplete: [issue #43335](https://github.com/openai/codex/issues/43335)
records that the first request in a reset window carries **no task state**,
because the notes body is not injected. This plugin therefore targets a
**handoff** reset — write the checkpoint into the fresh window instead of hoping
the model wrote notes.

## Install

```bash
dsh plugin --profile web add dsh-context-window
```

`package.json` declares `dsh.bundle.patch`, so this one command mounts the
plugin. It stays inert until `enabled: true`.

### Mounting constraint

`ctx.compaction` is realm-scoped. The shipped Web profile disables the
host-plane compaction rows and the `standard` agent preset mounts
`compaction-basic` inside `isolate: { compaction: true }`, while `tokenMeter`,
`tools`, and `systemPrompt` stay on the host plane. A host-plane mount can
therefore contribute the notice and the tool, but cannot become the agent's
compaction backend; a reset request is then reported and dropped rather than
silently mutating history.

## Configuration

See the table in [README.md](README.md#配置) — the field names, defaults, and
failure modes are identical. Invalid configuration rejects the plugin at load
time.

## Known limitations

- A host-plane mount cannot own `ctx.compaction`.
- A reset can only land on a step boundary: the seam refuses a cut through a
  live tool call, so Codex's mid-turn reset is deliberately not reproduced.
- The token meter is a heuristic (four characters per token); CJK and JSON
  schemas are underpriced, so thresholds fire late.
- `handoff` mode is not implemented; v0 warns and drops the request.

## Development

```bash
pnpm install
pnpm check   # typecheck → lint → build → test
```

## License

MIT
