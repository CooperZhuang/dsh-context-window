import { describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  boundNotes,
  extractHandoff,
  NotesBuffer,
  readLastHumanRequest,
  readPriorCheckpointNotes,
} from '../src/handoff.ts'
import { renderHandoffCheckpoint } from '../src/notice.ts'

/** One derived-history entry, with only the fields the extractor reads. */
type FakeMessage = Pick<Message, 'role' | 'source' | 'content'>

/**
 * Build a session stub exposing just `deriveMessages`.
 * @param messages - the derived history the stub returns.
 * @returns a value assignable to `Session` for the extractor's purposes.
 */
function sessionOf(messages: FakeMessage[]): Session {
  return { deriveMessages: () => messages } as unknown as Session
}

/**
 * @param text - the human request text.
 * @returns a human user message.
 */
function human(text: string): FakeMessage {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/**
 * @param text - the tool output text.
 * @returns a tool-result user message.
 */
function toolResult(text: string): FakeMessage {
  return {
    role: 'user',
    source: { kind: 'tool', callId: 'c1' } as FakeMessage['source'],
    content: [{ type: 'text', text }],
  }
}

/**
 * @param text - the snapshot text.
 * @returns a plugin snapshot user message.
 */
function pluginSnapshot(text: string): FakeMessage {
  return {
    role: 'user',
    source: { kind: 'plugin', plugin: 'context-window', form: 'snapshot', sections: [{ name: 'x', text }] },
    content: [{ type: 'text', text }],
  }
}

/** Base extraction input with caps that never bind. */
const base = {
  from: { ordinal: 1, id: 'w1' },
  notes: [] as readonly string[],
  maxTodos: 12,
  maxRequestChars: 2_000,
}

describe('readLastHumanRequest', () => {
  it('skips tool results and plugin snapshots', () => {
    const session = sessionOf([
      human('first ask'),
      toolResult('output'),
      pluginSnapshot('<context_window>'),
      human('second ask'),
      toolResult('more output'),
    ])
    expect(readLastHumanRequest(session, 2_000)).toBe('second ask')
  })

  it('returns undefined when the surface holds no human message', () => {
    expect(readLastHumanRequest(sessionOf([toolResult('x')]), 2_000)).toBeUndefined()
  })

  it('ellipsizes beyond the cap', () => {
    expect(readLastHumanRequest(sessionOf([human('abcdef')]), 3)).toBe('abc…')
  })
})

describe('extractHandoff', () => {
  it('renders a transition-only checkpoint for an empty session', () => {
    const state = extractHandoff({ ...base, session: sessionOf([]) })
    expect(state.todos).toEqual([])
    expect(state.goal).toBeUndefined()
    expect(state.lastHumanRequest).toBeUndefined()
    expect(renderHandoffCheckpoint({ ...state, toOrdinal: 2, toId: 'w2' }).split('\n')).toHaveLength(4)
  })

  it('reads the goal state shape and the bare client view shape', () => {
    const goal = { objective: 'ship the handoff', phase: 'blocked', blockedReason: { code: 'x', message: 'y' } }
    const viaState = extractHandoff({
      ...base,
      session: sessionOf([]),
      stateOf: (_session, key) => (key === 'goal' ? { current: { goal }, seenGoalIds: [], failure: null } : undefined),
    })
    expect(viaState.goal?.objective).toBe('ship the handoff')
    expect(viaState.goal?.blockedReason).toEqual({ code: 'x', message: 'y' })

    const viaView = extractHandoff({
      ...base,
      session: sessionOf([]),
      stateOf: (_session, key) => (key === 'goal' ? { goal, roundsStarted: 1 } : undefined),
    })
    expect(viaView.goal?.phase).toBe('blocked')
  })

  it('keeps open todos in order and drops completed ones', () => {
    const state = extractHandoff({
      ...base,
      session: sessionOf([]),
      stateOf: (_session, key) => (key === 'todos'
        ? [
            { content: 'done thing', status: 'completed' },
            { content: 'current thing', status: 'in_progress' },
            { content: 'later thing', status: 'pending' },
          ]
        : undefined),
    })
    expect(state.todos).toEqual([
      { content: 'current thing', status: 'in_progress' },
      { content: 'later thing', status: 'pending' },
    ])
  })

  it('caps the todo list', () => {
    const state = extractHandoff({
      ...base,
      session: sessionOf([]),
      maxTodos: 1,
      stateOf: () => [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }],
    })
    expect(state.todos).toHaveLength(1)
  })

  it('survives a throwing or malformed projection', () => {
    const state = extractHandoff({
      ...base,
      session: sessionOf([]),
      stateOf: () => { throw new Error('registry exploded') },
    })
    expect(state.todos).toEqual([])
    expect(state.goal).toBeUndefined()

    const malformed = extractHandoff({ ...base, session: sessionOf([]), stateOf: () => 'not a list' })
    expect(malformed.todos).toEqual([])
  })

  it('ignores unusable todo entries', () => {
    const state = extractHandoff({
      ...base,
      session: sessionOf([]),
      stateOf: () => [{ content: '  ', status: 'pending' }, { content: 'ok', status: 'nope' }, { content: 'kept', status: 'pending' }],
    })
    expect(state.todos).toEqual([{ content: 'kept', status: 'pending' }])
  })
})

describe('renderHandoffCheckpoint', () => {
  const content = extractHandoff({
    ...base,
    session: sessionOf([human('do the thing')]),
    notes: ['the seam forbids unbalanced cuts'],
    stateOf: (_session, key) => {
      if (key === 'goal') return { current: { goal: { objective: 'finish v1', phase: 'active' } } }
      if (key === 'todos') return [{ content: 'write tests', status: 'in_progress' }]
      return undefined
    },
  })
  const state = { ...content, toOrdinal: 2, toId: 'w2' }

  it('names the transition and every carried section', () => {
    const text = renderHandoffCheckpoint(state)
    expect(text.startsWith('<context_handoff>')).toBe(true)
    expect(text.endsWith('</context_handoff>')).toBe(true)
    expect(text).toContain('Context window 1 (id w1) ended; this is context window 2 (id w2).')
    expect(text).toContain('<objective phase="active">\nfinish v1\n</objective>')
    expect(text).toContain('<remaining_work>\n- [~] write tests\n</remaining_work>')
    expect(text).toContain('<notes>\n- the seam forbids unbalanced cuts\n</notes>')
    expect(text).toContain('<last_human_request>\ndo the thing\n</last_human_request>')
  })

  it('rejects an invalid ordinal', () => {
    expect(() => renderHandoffCheckpoint({ ...state, toOrdinal: 0 })).toThrow(RangeError)
  })
})

describe('readPriorCheckpointNotes', () => {
  it('reads the notes back out of the newest checkpoint', () => {
    const checkpoint = renderHandoffCheckpoint({
      ...extractHandoff({ ...base, session: sessionOf([]), notes: ['first note', 'second note'] }),
      toOrdinal: 2,
      toId: 'w2',
    })
    const session = sessionOf([human('hi'), pluginSnapshot(checkpoint), pluginSnapshot('<context_window>')])
    expect(readPriorCheckpointNotes(session)).toEqual(['first note', 'second note'])
  })

  it('returns empty when no checkpoint is on the surface', () => {
    expect(readPriorCheckpointNotes(sessionOf([human('hi')]))).toEqual([])
  })

  it('returns empty for a checkpoint without a notes section', () => {
    const checkpoint = renderHandoffCheckpoint({
      ...extractHandoff({ ...base, session: sessionOf([]) }),
      toOrdinal: 2,
      toId: 'w2',
    })
    expect(readPriorCheckpointNotes(sessionOf([pluginSnapshot(checkpoint)]))).toEqual([])
  })
})

describe('boundNotes', () => {
  it('keeps notes that fit the budget', () => {
    expect(boundNotes(['ab', 'cd'], 4)).toEqual(['ab', 'cd'])
  })

  it('stops at the first note that would exceed the budget', () => {
    expect(boundNotes(['ab', 'cde'], 4)).toEqual(['ab'])
  })

  it('drops everything at a zero budget', () => {
    expect(boundNotes(['a'], 0)).toEqual([])
  })
})

describe('NotesBuffer', () => {
  it('keeps notes in write order', () => {
    const buffer = new NotesBuffer(8, 100)
    buffer.add('a')
    buffer.add('b')
    expect(buffer.list()).toEqual(['a', 'b'])
  })

  it('evicts the oldest note at the cap', () => {
    const buffer = new NotesBuffer(2, 100)
    buffer.add('a')
    buffer.add('b')
    buffer.add('c')
    expect(buffer.list()).toEqual(['b', 'c'])
  })

  it('truncates a long note', () => {
    const buffer = new NotesBuffer(4, 3)
    buffer.add('abcdef')
    expect(buffer.list()).toEqual(['abc…'])
  })

  it('ignores a blank note', () => {
    const buffer = new NotesBuffer(4, 100)
    expect(buffer.add('   ')).toBe(false)
    expect(buffer.isEmpty).toBe(true)
  })

  it('records nothing when the cap is zero', () => {
    const buffer = new NotesBuffer(0, 100)
    expect(buffer.add('a')).toBe(false)
  })

  it('seeds from recovered notes and clears after a checkpoint', () => {
    const buffer = new NotesBuffer(4, 100)
    buffer.seed(['recovered'])
    expect(buffer.list()).toEqual(['recovered'])
    buffer.clear()
    expect(buffer.isEmpty).toBe(true)
  })

  it('rejects invalid caps', () => {
    expect(() => new NotesBuffer(-1, 10)).toThrow(RangeError)
    expect(() => new NotesBuffer(1, 0)).toThrow(RangeError)
  })
})
