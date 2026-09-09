/**
 * The model-visible text of the feature, kept separate from the plugin wiring
 * so every string is reviewable and unit-testable in one place.
 *
 * Three messages exist:
 *
 * - the **window notice** (`<context_window>`), injected every assembly: which
 *   window this is, which came before, and how many tokens are left;
 * - the **reset reminder**, injected once the budget is nearly spent: warns
 *   that the window is about to be cleared, that only notes and history
 *   survive the switch, and that the `notes` tool is how the model writes them;
 * - the **handoff checkpoint** (`<context_handoff>`), written into the fresh
 *   window by `resetMode: 'handoff'`: the window transition, the objective, the
 *   open todos, the model's notes, and the human's last request. This is the
 *   message that fixes Codex's open issue #43335.
 *
 * @module dsh-context-window/notice
 */
import type { HandoffState } from './handoff.ts'

/** Opening tag of the model-visible window notice. */
export const CONTEXT_WINDOW_OPEN_TAG = '<context_window>'

/** Closing tag of the model-visible window notice. */
export const CONTEXT_WINDOW_CLOSE_TAG = '</context_window>'

/** Opening tag of the handoff checkpoint written into a fresh window. */
export const HANDOFF_OPEN_TAG = '<context_handoff>'

/** Closing tag of the handoff checkpoint. */
export const HANDOFF_CLOSE_TAG = '</context_handoff>'

/** Codex's default pre-reset reminder; `{n_remaining}` and `{notes_tool}` are substituted. */
export const DEFAULT_RESET_REMINDER_TEMPLATE =
  'Your context window is nearly exhausted (only {n_remaining} tokens remaining) and will be automatically reset for you soon. '
  + 'Once reset, message items in the current context window will be cleared in the new window, but notes and history items will be persistent across windows. '
  + 'Before the reset, call the {notes_tool} tool once to record anything the next window must not lose.'

/** Inputs for the window notice. */
export interface WindowNoticeInput {
  /** Current 1-based window ordinal. */
  readonly ordinal: number
  /** Tokens left before the usable window is exhausted. */
  readonly remainingTokens: number
  /** Id of the session's first window, when the notice should name it. */
  readonly firstId?: string | undefined
  /** Id of the previous window, when there was one. */
  readonly previousId?: string | undefined
  /** Id of the current window, when the notice should name it. */
  readonly currentId?: string | undefined
}

/**
 * Render the `<context_window>` notice. Window ids are included only when
 * supplied, so a minimal deployment gets the two-line Codex form.
 * @param input - window ordinal, remaining tokens, and optional id chain.
 * @returns the notice text, tags included.
 */
export function renderWindowNotice(input: WindowNoticeInput): string {
  if (!Number.isInteger(input.ordinal) || input.ordinal < 1) {
    throw new RangeError(`context-window: invalid ordinal ${String(input.ordinal)} — expected a positive integer`)
  }
  if (!Number.isFinite(input.remainingTokens) || input.remainingTokens < 0) {
    throw new RangeError(`context-window: invalid remainingTokens ${String(input.remainingTokens)} — expected a non-negative finite token count`)
  }
  const lines = [`Current context window ${input.ordinal}.`]
  if (input.firstId !== undefined) lines.push(`First context window id ${input.firstId}.`)
  if (input.previousId !== undefined) lines.push(`Previous context window id ${input.previousId}.`)
  if (input.currentId !== undefined) lines.push(`Current context window id ${input.currentId}.`)
  lines.push(`You have ${Math.floor(input.remainingTokens)} tokens left in this context window.`)
  return [CONTEXT_WINDOW_OPEN_TAG, ...lines, CONTEXT_WINDOW_CLOSE_TAG].join('\n')
}

/**
 * Render the `<context_handoff>` checkpoint — the content of the first message
 * in a freshly reset window.
 *
 * Sections are omitted rather than rendered empty, so a checkpoint for a
 * session with nothing to say is two lines long. The notes section is written
 * one `- ` bullet per note, which is exactly the shape
 * {@link extractNotesSection} reads back after a resume.
 * @param state - the assembled handoff state.
 * @returns the checkpoint text, tags included.
 */
export function renderHandoffCheckpoint(state: HandoffState): string {
  assertPositiveInteger(state.fromOrdinal, 'fromOrdinal')
  assertPositiveInteger(state.toOrdinal, 'toOrdinal')
  const lines: string[] = [
    HANDOFF_OPEN_TAG,
    `Context window ${state.fromOrdinal} (id ${state.fromId}) ended; this is context window ${state.toOrdinal} (id ${state.toId}).`,
    'The messages of the previous window are gone. The state below was carried over verbatim.',
  ]
  if (state.goal !== undefined) {
    const blocked = state.goal.blockedReason === undefined
      ? ''
      : ` (blocked: ${state.goal.blockedReason.code} — ${state.goal.blockedReason.message})`
    lines.push('', `<objective phase="${state.goal.phase}"${blocked === '' ? '' : escapeAttribute(blocked)}>`, state.goal.objective, '</objective>')
  }
  if (state.todos.length > 0) {
    lines.push('', '<remaining_work>')
    for (const todo of state.todos) {
      lines.push(`- [${todo.status === 'in_progress' ? '~' : ' '}] ${todo.content}`)
    }
    lines.push('</remaining_work>')
  }
  if (state.notes.length > 0) {
    lines.push('', '<notes>')
    for (const note of state.notes) lines.push(`- ${note}`)
    lines.push('</notes>')
  }
  if (state.lastHumanRequest !== undefined) {
    lines.push('', '<last_human_request>', state.lastHumanRequest, '</last_human_request>')
  }
  lines.push(HANDOFF_CLOSE_TAG)
  return lines.join('\n')
}

/**
 * Read the notes back out of a rendered checkpoint.
 *
 * The round trip is what makes the notes durable: the checkpoint is on the
 * session surface, so a resumed process recovers them from the log instead of
 * needing a storage domain of its own.
 * @param checkpointText - a rendered `<context_handoff>` block.
 * @returns the notes in section order; empty when the block carries none.
 */
export function extractNotesSection(checkpointText: string): readonly string[] {
  const open = checkpointText.indexOf('<notes>')
  if (open < 0) return Object.freeze([])
  const close = checkpointText.indexOf('</notes>', open)
  if (close < 0) return Object.freeze([])
  const body = checkpointText.slice(open + '<notes>'.length, close)
  const notes: string[] = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('- ')) continue
    const note = line.slice(2).trim()
    if (note !== '') notes.push(note)
  }
  return Object.freeze(notes)
}

/**
 * Substitute `{n_remaining}` and `{notes_tool}` in a reminder template. The
 * template is validated at load time, so an unsubstituted placeholder here is a
 * programming error.
 * @param template - the configured reminder template.
 * @param remainingTokens - tokens left before the window resets.
 * @param notesToolName - name of the model-facing notes tool, when one is registered.
 * @returns the rendered reminder.
 */
export function renderResetReminder(template: string, remainingTokens: number, notesToolName?: string): string {
  if (!Number.isFinite(remainingTokens) || remainingTokens < 0) {
    throw new RangeError(`context-window: invalid remainingTokens ${String(remainingTokens)} — expected a non-negative finite token count`)
  }
  return template
    .replaceAll('{n_remaining}', String(Math.floor(remainingTokens)))
    .replaceAll('{notes_tool}', notesToolName ?? 'notes')
}

/**
 * Validate a reminder template at load time.
 * @param template - the configured template.
 * @throws when the template is empty or lacks the `{n_remaining}` placeholder.
 */
export function assertReminderTemplate(template: string): void {
  if (template.trim() === '') throw new Error('context-window: resetReminderTemplate must not be empty')
  if (!template.includes('{n_remaining}')) {
    throw new Error('context-window: resetReminderTemplate must contain the {n_remaining} placeholder')
  }
}

/**
 * @param value - candidate ordinal.
 * @param label - field name used in the error message.
 * @throws when the value is not a positive integer.
 */
function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`context-window: invalid ${label} ${String(value)} — expected a positive integer`)
  }
}

/**
 * Escape a rendered attribute value.
 * @param value - raw attribute text.
 * @returns the text safe to place inside double quotes.
 */
function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}
