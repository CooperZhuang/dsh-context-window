/**
 * The model-visible text of the feature, kept separate from the plugin wiring
 * so every string is reviewable and unit-testable in one place.
 *
 * Two messages exist, matching Codex's pair:
 *
 * - the **window notice** (`<context_window>`), injected every assembly: which
 *   window this is, which came before, and how many tokens are left;
 * - the **reset reminder**, injected once the budget is nearly spent: warns
 *   that the window is about to be cleared and that only notes and history
 *   survive the switch, which is what makes the model write state out first.
 *
 * @module dsh-context-window/notice
 */

/** Opening tag of the model-visible window notice. */
export const CONTEXT_WINDOW_OPEN_TAG = '<context_window>'

/** Closing tag of the model-visible window notice. */
export const CONTEXT_WINDOW_CLOSE_TAG = '</context_window>'

/** Codex's default pre-reset reminder; `{n_remaining}` is substituted. */
export const DEFAULT_RESET_REMINDER_TEMPLATE =
  'Your context window is nearly exhausted (only {n_remaining} tokens remaining) and will be automatically reset for you soon. '
  + 'Once reset, message items in the current context window will be cleared in the new window, but notes and history items will be persistent across windows.'

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
 * Substitute `{n_remaining}` in a reminder template. The template is validated
 * at load time, so an unsubstituted placeholder here is a programming error.
 * @param template - the configured reminder template.
 * @param remainingTokens - tokens left before the window resets.
 * @returns the rendered reminder.
 */
export function renderResetReminder(template: string, remainingTokens: number): string {
  if (!Number.isFinite(remainingTokens) || remainingTokens < 0) {
    throw new RangeError(`context-window: invalid remainingTokens ${String(remainingTokens)} — expected a non-negative finite token count`)
  }
  return template.replaceAll('{n_remaining}', String(Math.floor(remainingTokens)))
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
