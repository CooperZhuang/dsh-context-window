/**
 * The template half of the handoff: everything the plugin can assemble about a
 * session **without asking a model to write it**.
 *
 * This is design decision U1 option *a*, paired with option *c* — the reset
 * reminder asks the model to call the `notes` tool before the window turns
 * over, and this module carries those notes across. The point is that a fresh
 * window never opens with *nothing*: even a model that ignores the reminder
 * finds the objective, the open todos, and the human's last request already
 * there. Codex's reset path (option *c* alone) has no such floor, which is why
 * its open issue #43335 reports a first post-reset request with no task state.
 *
 * Two rules shape the extraction:
 *
 * - **Projections are optional.** `todos` and `goal` come from
 *   `ctx.sessionProjections`, a host-plane service this plugin does not depend
 *   on. A missing registry, a missing key, or a malformed value degrades to an
 *   absent section — never to an exception on the reset path.
 * - **The last human message is the last `kind: 'user'` message.** Tool results
 *   are also user-role messages, and every plugin snapshot (including this
 *   plugin's own notices) is user-role too, so neither may be mistaken for a
 *   human request.
 *
 * @module dsh-context-window/handoff
 */
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { extractNotesSection, HANDOFF_OPEN_TAG } from './notice.ts'

/** One todo entry, structurally compatible with the `todos` projection value. */
export interface HandoffTodo {
  /** The task line. */
  readonly content: string
  /** Lifecycle state. */
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** The goal fields a handoff renders, structurally compatible with the `goal` projection state. */
export interface HandoffGoal {
  /** The human-requested completion objective. */
  readonly objective: string
  /** Durable lifecycle phase. */
  readonly phase: string
  /** Present exactly while the goal is blocked. */
  readonly blockedReason?: { readonly code: string, readonly message: string } | undefined
}

/** Everything one handoff checkpoint carries into the next window. */
export interface HandoffState {
  /** The session's current goal, when a goal projection is mounted and set. */
  readonly goal?: HandoffGoal | undefined
  /** The open todos at reset time, in list order. */
  readonly todos: readonly HandoffTodo[]
  /** The notes the model wrote for this transition, in write order. */
  readonly notes: readonly string[]
  /** The human's most recent request text, when one is on the surface. */
  readonly lastHumanRequest?: string | undefined
  /** 1-based ordinal of the window that is being left. */
  readonly fromOrdinal: number
  /** Id of the window that is being left. */
  readonly fromId: string
  /** 1-based ordinal of the window that is being entered. */
  readonly toOrdinal: number
  /** Id of the window that is being entered. */
  readonly toId: string
}

/** The carried content of a handoff, before the incoming window has an id. */
export type HandoffContent = Omit<HandoffState, 'toOrdinal' | 'toId'>

/**
 * Read one optional session projection without depending on its package.
 * `ctx.sessionProjections.stateOf` satisfies this signature; the plugin passes
 * it through so this module stays pure and unit-testable.
 * @param session - the session whose projection state is read.
 * @param key - the projection key, for example `todos` or `goal`.
 * @returns the projection state, or `undefined` when the unit is not mounted.
 */
export type ProjectionReader = (session: Session, key: string) => unknown

/** Inputs for {@link extractHandoff}. */
export interface ExtractHandoffInput {
  /** The session whose surface is leaving the window. */
  readonly session: Session
  /** The window being left. */
  readonly from: { readonly ordinal: number, readonly id: string }
  /** Notes the model wrote in this window, in write order. */
  readonly notes: readonly string[]
  /** Optional projection reader; omit when no projection registry is mounted. */
  readonly stateOf?: ProjectionReader | undefined
  /** Cap on retained todos; extra entries are dropped from the tail. */
  readonly maxTodos: number
  /** Cap on the rendered characters of the last human request. */
  readonly maxRequestChars: number
}

/**
 * Assemble the handoff content from a live session.
 *
 * Every field is independently optional: the result is always renderable, and
 * a session with no goal, no todos, and no human message yet yields a
 * checkpoint that at least names the window transition.
 * @param input - session, outgoing window, notes, projection reader, and caps.
 * @returns the assembled content, without the incoming window's identity.
 */
export function extractHandoff(input: ExtractHandoffInput): HandoffContent {
  const { session } = input
  return Object.freeze({
    goal: readGoal(input),
    todos: readTodos(input),
    notes: Object.freeze([...input.notes]),
    lastHumanRequest: readLastHumanRequest(session, input.maxRequestChars),
    fromOrdinal: input.from.ordinal,
    fromId: input.from.id,
  })
}

/**
 * Read the goal projection.
 *
 * The `goal` unit's state is `{ current, seenGoalIds, failure }`; the client
 * view is the bare `GoalProjection`. Both shapes are accepted, because which
 * one a deployment exposes depends on the projection package's version rather
 * than on anything this plugin controls.
 * @param input - extraction inputs.
 * @returns the goal, or `undefined` when none is set or the value is unusable.
 */
function readGoal(input: ExtractHandoffInput): HandoffGoal | undefined {
  const state = readProjection(input, 'goal')
  if (state === undefined) return undefined
  const current = isRecord(state) && isRecord(state.current) ? state.current : state
  const goal = isRecord(current) && isRecord(current.goal) ? current.goal : current
  if (!isRecord(goal)) return undefined
  const objective = goal.objective
  if (typeof objective !== 'string' || objective.trim() === '') return undefined
  const phase = typeof goal.phase === 'string' && goal.phase !== '' ? goal.phase : 'active'
  const blockedReason = isRecord(goal.blockedReason)
    && typeof goal.blockedReason.code === 'string'
    && typeof goal.blockedReason.message === 'string'
    ? { code: goal.blockedReason.code, message: goal.blockedReason.message }
    : undefined
  return { objective, phase, blockedReason }
}

/**
 * Read the todo projection, keeping only the entries that still need work.
 * Completed entries are dropped: a fresh window needs the remaining work, and
 * carrying the full history back would grow the checkpoint every reset.
 * @param input - extraction inputs.
 * @returns the open todos, capped at `maxTodos`.
 */
function readTodos(input: ExtractHandoffInput): readonly HandoffTodo[] {
  const state = readProjection(input, 'todos')
  if (!Array.isArray(state)) return Object.freeze([])
  const open: HandoffTodo[] = []
  for (const entry of state) {
    if (open.length >= input.maxTodos) break
    if (!isRecord(entry)) continue
    const { content, status } = entry
    if (typeof content !== 'string' || content.trim() === '') continue
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    if (status === 'completed') continue
    open.push({ content, status })
  }
  return Object.freeze(open)
}

/**
 * Call the optional projection reader and swallow nothing but absence: a
 * throwing registry would otherwise break the reset path it is decorating.
 * @param input - extraction inputs.
 * @param key - projection key to read.
 * @returns the raw state, or `undefined`.
 */
function readProjection(input: ExtractHandoffInput, key: string): unknown {
  if (input.stateOf === undefined) return undefined
  try {
    return input.stateOf(input.session, key)
  } catch {
    return undefined
  }
}

/**
 * Find the human's most recent request on the model-visible surface.
 *
 * Walks the derived history backwards, skipping tool results, plugin
 * snapshots, and this plugin's own checkpoints, and returns the last message a
 * human actually typed.
 * @param session - the session to read.
 * @param maxChars - cap on the returned text; longer requests are ellipsized.
 * @returns the request text, or `undefined` when the surface holds no human message.
 */
export function readLastHumanRequest(session: Session, maxChars: number): string | undefined {
  const messages = session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role !== 'user' || message.source.kind !== 'user') continue
    const text = messageText(message)
    if (text === '') continue
    return maxChars > 0 && text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
  }
  return undefined
}

/**
 * Concatenate the text blocks of one message.
 * @param message - the message to flatten.
 * @returns the joined text, possibly empty.
 */
function messageText(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Recover the notes recorded by the previous checkpoint on the surface.
 *
 * Notes live in the per-session runtime, which a process restart loses while
 * the session log survives. Reading the newest checkpoint back is what makes
 * the notes durable across a resume without a second storage domain.
 * @param session - the session whose surface is searched.
 * @returns the notes in the newest checkpoint, newest first section order; empty when there is none.
 */
export function readPriorCheckpointNotes(session: Session): readonly string[] {
  const messages = session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user') continue
    const text = messageText(message)
    if (!text.startsWith(HANDOFF_OPEN_TAG)) continue
    return extractNotesSection(text)
  }
  return Object.freeze([])
}

/**
 * Accumulates the notes the model writes for the next window.
 *
 * Bounded twice over — per note and in total — because the notes are re-sent
 * in every subsequent checkpoint and an unbounded list would make each reset
 * slightly fatter than the last (design doc §3, "交接内容重复累积").
 */
export class NotesBuffer {
  private readonly notes: string[] = []

  /**
   * @param maxNotes - maximum retained notes; the oldest is evicted first.
   * @param maxNoteChars - maximum characters per note; longer notes are truncated.
   */
  constructor(
    private readonly maxNotes: number,
    private readonly maxNoteChars: number,
  ) {
    if (!Number.isInteger(maxNotes) || maxNotes < 0) {
      throw new RangeError(`context-window: invalid maxNotes ${String(maxNotes)} — expected a non-negative integer`)
    }
    if (!Number.isInteger(maxNoteChars) || maxNoteChars <= 0) {
      throw new RangeError(`context-window: invalid maxNoteChars ${String(maxNoteChars)} — expected a positive integer`)
    }
  }

  /** @returns the retained notes in write order. */
  list(): readonly string[] {
    return this.notes
  }

  /** @returns whether the buffer holds no notes. */
  get isEmpty(): boolean {
    return this.notes.length === 0
  }

  /**
   * Seed the buffer from a previous checkpoint, used when a session is resumed
   * and the in-memory notes are gone but the log is not.
   * @param notes - notes recovered from the newest checkpoint on the surface.
   */
  seed(notes: readonly string[]): void {
    for (const note of notes) this.add(note)
  }

  /**
   * Record one note.
   * @param note - the note text; whitespace-only input is ignored.
   * @returns whether the note was retained.
   */
  add(note: string): boolean {
    const trimmed = note.trim()
    if (trimmed === '' || this.maxNotes === 0) return false
    const bounded = trimmed.length > this.maxNoteChars
      ? `${trimmed.slice(0, this.maxNoteChars)}…`
      : trimmed
    this.notes.push(bounded)
    while (this.notes.length > this.maxNotes) this.notes.shift()
    return true
  }

  /** Drop every note once they have been carried into a checkpoint. */
  clear(): void {
    this.notes.length = 0
  }
}

/**
 * Bound notes recovered from a persisted checkpoint.
 *
 * The recovered text is model-written and log-resident, so it is trusted no
 * further than the fresh notes path: an oversized section is trimmed before it
 * can be re-sent in every later checkpoint.
 * @param notes - notes read back from the newest checkpoint.
 * @param maxChars - total character budget; `0` drops every note.
 * @returns the notes that fit, in order.
 */
export function boundNotes(notes: readonly string[], maxChars: number): readonly string[] {
  if (maxChars === 0) return Object.freeze([])
  const kept: string[] = []
  let used = 0
  for (const note of notes) {
    if (used + note.length > maxChars) break
    kept.push(note)
    used += note.length
  }
  return Object.freeze(kept)
}

/**
 * @param value - candidate value.
 * @returns whether the value is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
