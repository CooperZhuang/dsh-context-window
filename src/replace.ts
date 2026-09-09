/**
 * The model-free surface replacement that makes `resetMode: 'handoff'` a real
 * reset rather than a summary.
 *
 * Codex's reset path (`compact_token_budget.rs`) skips summarization entirely
 * and installs a fresh window's initial context. DSH's compaction seam cannot
 * express that: `CompactionEngine.compactRegion` always summarizes, because
 * every backend's `summarize` hook is what produces its replacement message.
 * A handoff reset therefore writes the surface itself, and this module owns
 * that write plus the two protocol details that make it legal:
 *
 * - `surfaceOp: { op: 'replace', start, end }` shadows every current node, and
 *   `sourceEventSeqs` cites them all — the surface contract requires complete
 *   shadowed-node coverage.
 * - A `compaction/prune` event immediately before the replacement arms the
 *   token meter's shadow-price claim. Without an armed claim a replacement
 *   folds with zero delta, which would leave the replaced range's tokens
 *   charged against the budget forever.
 *
 * Both appends are synchronous, so no event can interleave between the claim
 * and the replacement it prices.
 *
 * @module dsh-context-window/replace
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'

/** How the replacement message is attributed in the session log. */
export interface CheckpointSource {
  /** Plugin name recorded as `source.plugin`. */
  readonly plugin: string
  /** Snapshot section name, used by UI surfaces to label the row. */
  readonly section: string
}

/** Inputs for {@link replaceSurfaceWithCheckpoint}. */
export interface ReplaceSurfaceInput {
  /** The session whose surface is replaced. */
  readonly session: Session
  /** The replacement text, already rendered. */
  readonly text: string
  /** The surface nodes being replaced, in surface order; must be non-empty. */
  readonly shadowed: readonly SessionSeq[]
  /** Message provenance for the replacement. */
  readonly source: CheckpointSource
  /** Token meter used to price the shadowed range; omit when none is mounted. */
  readonly meter?: TokenMeter | undefined
}

/**
 * Replace every shadowed surface node with one checkpoint message.
 *
 * The caller must have established that `shadowed` is the complete current
 * surface and that it is tool-pairing balanced; this function only writes.
 * @param input - session, replacement text, shadowed nodes, provenance, and meter.
 * @returns the seq of the appended replacement event.
 * @throws when `shadowed` is empty or the append violates the surface contract.
 */
export function replaceSurfaceWithCheckpoint(input: ReplaceSurfaceInput): SessionSeq {
  const { session, shadowed } = input
  const start = shadowed[0]
  const end = shadowed[shadowed.length - 1]
  if (start === undefined || end === undefined) {
    throw new Error('context-window: cannot replace an empty surface')
  }

  session.append('compaction/prune', {
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowed],
    shadowedTokenCount: input.meter === undefined ? 0 : input.meter.measure(session).surfaceTokens,
  })

  const replacement = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: input.text }],
    source: {
      kind: 'plugin',
      plugin: input.source.plugin,
      form: 'snapshot',
      sections: [{ name: input.source.section, text: input.text }],
    },
  }), {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [...shadowed],
  })
  return replacement.seq
}

/**
 * Whether a compaction transaction is open on this session.
 *
 * The plugin writes its own surface replacement in `handoff` mode, so it must
 * not interleave with a backend-owned bracket. Scanning for an unmatched
 * `compaction/start` is the log-only equivalent of the seam's busy check: the
 * marker pair is durable, so replay gives the same answer.
 * @param session - the session to inspect.
 * @returns whether a `compaction/start` marker lacks its `compaction/end`.
 */
export function hasOpenCompaction(session: Session): boolean {
  const open = new Set<string>()
  for (const event of session.snapshotEvents()) {
    if (event.type === 'compaction/start') open.add(String(event.data.compactionId))
    else if (event.type === 'compaction/end') open.delete(String(event.data.compactionId))
  }
  return open.size > 0
}
