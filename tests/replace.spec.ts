import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq as Seq, SurfaceOp } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { hasOpenCompaction, replaceSurfaceWithCheckpoint } from '../src/replace.ts'

/** One logged event, kept as loosely as the assertions need. */
interface LoggedEvent {
  type: string
  seq: Seq
  data: Record<string, unknown>
  surfaceOp?: SurfaceOp
  sourceEventSeqs?: Seq[]
}

/**
 * A session stub that enforces the surface rules the replacement must satisfy:
 * a `replace` range must exist in the current surface, and its cited source
 * seqs must be unique and cover every shadowed node.
 * @param initial - the surface nodes the session starts with.
 * @returns the stub plus its event log.
 */
function fakeSession(initial: number[]): { session: Session, events: LoggedEvent[], surface: Seq[] } {
  const events: LoggedEvent[] = []
  const surface: Seq[] = initial.map((value) => SessionSeq(value))
  let next = initial.length === 0 ? 0 : Math.max(...initial) + 1

  const append = (
    type: string,
    data: Record<string, unknown>,
    opts?: { surfaceOp: SurfaceOp, sourceEventSeqs?: Seq[] },
  ): SessionEvent => {
    const seq = SessionSeq(next)
    next += 1
    if (opts === undefined) {
      // Log-only event: recorded, never on the surface.
      events.push({ type, seq, data })
      return { type, seq, time: 0, data } as unknown as SessionEvent
    }
    const op = opts.surfaceOp
    if (typeof op === 'object') {
      const startIndex = surface.indexOf(op.start)
      const endIndex = surface.indexOf(op.end)
      if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
        throw new Error('surface replacement range is missing, reversed, or out of order')
      }
      const shadowed = surface.slice(startIndex, endIndex + 1)
      const cited = opts.sourceEventSeqs ?? []
      if (cited.length !== new Set(cited.map(String)).size) throw new Error('duplicate source seq')
      for (const seq of shadowed) {
        if (!cited.includes(seq)) throw new Error(`source seqs do not cover shadowed node ${String(seq)}`)
      }
      const event: LoggedEvent = { type, seq, data, surfaceOp: opts.surfaceOp, sourceEventSeqs: opts.sourceEventSeqs }
      events.push(event)
      surface.splice(startIndex, endIndex - startIndex + 1, seq)
      return { type, seq, time: 0, data } as unknown as SessionEvent
    }
    const event: LoggedEvent = { type, seq, data, surfaceOp: opts.surfaceOp, sourceEventSeqs: opts.sourceEventSeqs }
    events.push(event)
    surface.push(seq)
    return { type, seq, time: 0, data } as unknown as SessionEvent
  }

  const session = {
    surface: { nodes: surface, replaceGeneration: 0 },
    append,
    snapshotEvents: () => events as unknown as SessionEvent[],
  } as unknown as Session
  return { session, events, surface }
}

/** A meter whose measurement is a fixed surface token count. */
function fakeMeter(surfaceTokens: number): TokenMeter {
  return { measure: () => ({ surfaceTokens }) } as unknown as TokenMeter
}

const source = { plugin: 'context-window', section: 'context-window:handoff' }

describe('replaceSurfaceWithCheckpoint', () => {
  it('arms the shadow-price claim and replaces the whole surface', () => {
    const { session, events, surface } = fakeSession([0, 1, 2])
    const seq = replaceSurfaceWithCheckpoint({
      session,
      text: '<context_handoff>hello</context_handoff>',
      shadowed: [SessionSeq(0), SessionSeq(1), SessionSeq(2)],
      source,
      meter: fakeMeter(1234),
    })

    expect(events.map((event) => event.type)).toEqual(['compaction/prune', 'user/message'])
    const prune = events[0]
    expect(prune?.data.shadowedTokenCount).toBe(1234)
    expect(prune?.data.shadowedSeqs).toEqual([SessionSeq(0), SessionSeq(1), SessionSeq(2)])
    expect(prune?.data.shadowedRange).toEqual({ start: SessionSeq(0), end: SessionSeq(2) })
    expect(events[1]?.surfaceOp).toEqual({ op: 'replace', start: SessionSeq(0), end: SessionSeq(2) })
    expect(events[1]?.sourceEventSeqs).toEqual([SessionSeq(0), SessionSeq(1), SessionSeq(2)])
    expect(surface).toEqual([seq])
  })

  it('replaces a single-node surface', () => {
    const { session, surface } = fakeSession([7])
    replaceSurfaceWithCheckpoint({
      session,
      text: 'x',
      shadowed: [SessionSeq(7)],
      source,
    })
    expect(surface).toHaveLength(1)
  })

  it('prices zero when no meter is mounted', () => {
    const { session, events } = fakeSession([0])
    replaceSurfaceWithCheckpoint({ session, text: 'x', shadowed: [SessionSeq(0)], source })
    expect(events[0]?.data.shadowedTokenCount).toBe(0)
  })

  it('rejects an empty shadowed list', () => {
    const { session } = fakeSession([])
    expect(() => replaceSurfaceWithCheckpoint({ session, text: 'x', shadowed: [], source }))
      .toThrow('cannot replace an empty surface')
  })

  it('leaves the surface untouched when the replacement is rejected', () => {
    const { session, events, surface } = fakeSession([0, 1])
    expect(() => replaceSurfaceWithCheckpoint({
      session,
      text: 'x',
      shadowed: [SessionSeq(1), SessionSeq(0)],
      source,
    })).toThrow(/missing, reversed, or out of order/)
    expect(surface).toEqual([SessionSeq(0), SessionSeq(1)])
    expect(events.map((event) => event.type)).toEqual(['compaction/prune'])
  })
})

describe('hasOpenCompaction', () => {
  /**
   * @param events - the log the stub reports, as `[type, compactionId]` pairs.
   * @returns a session stub over that log.
   */
  function sessionOf(events: Array<[string, string]>): Session {
    return {
      snapshotEvents: () => events.map(([type, compactionId]) => ({ type, data: { compactionId } })),
    } as unknown as Session
  }

  it('is false for an empty log', () => {
    expect(hasOpenCompaction(sessionOf([]))).toBe(false)
  })

  it('is true while a start marker lacks its end', () => {
    expect(hasOpenCompaction(sessionOf([['compaction/start', 'c1']]))).toBe(true)
  })

  it('is false once the matching end marker lands', () => {
    expect(hasOpenCompaction(sessionOf([
      ['compaction/start', 'c1'],
      ['compaction/end', 'c1'],
    ]))).toBe(false)
  })

  it('tracks transactions independently', () => {
    expect(hasOpenCompaction(sessionOf([
      ['compaction/start', 'c1'],
      ['compaction/end', 'c1'],
      ['compaction/start', 'c2'],
    ]))).toBe(true)
  })
})
