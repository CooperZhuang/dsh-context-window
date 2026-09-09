import { describe, expect, it } from 'vitest'
import {
  assertReminderTemplate,
  CONTEXT_WINDOW_CLOSE_TAG,
  CONTEXT_WINDOW_OPEN_TAG,
  renderResetReminder,
  renderWindowNotice,
} from '../src/notice.ts'

describe('renderWindowNotice', () => {
  it('renders the minimal two-line Codex form', () => {
    expect(renderWindowNotice({ ordinal: 1, remainingTokens: 121_600 })).toBe([
      CONTEXT_WINDOW_OPEN_TAG,
      'Current context window 1.',
      'You have 121600 tokens left in this context window.',
      CONTEXT_WINDOW_CLOSE_TAG,
    ].join('\n'))
  })

  it('names the window id chain when supplied', () => {
    const text = renderWindowNotice({
      ordinal: 2,
      remainingTokens: 40_000,
      firstId: 'w1',
      previousId: 'w1',
      currentId: 'w2',
    })
    expect(text).toContain('First context window id w1.')
    expect(text).toContain('Previous context window id w1.')
    expect(text).toContain('Current context window id w2.')
  })

  it('floors a fractional remaining count', () => {
    expect(renderWindowNotice({ ordinal: 1, remainingTokens: 1_234.9 })).toContain('You have 1234 tokens left')
  })

  it('rejects an invalid ordinal', () => {
    expect(() => renderWindowNotice({ ordinal: 0, remainingTokens: 1 })).toThrow(RangeError)
  })

  it('rejects a negative remaining count', () => {
    expect(() => renderWindowNotice({ ordinal: 1, remainingTokens: -1 })).toThrow(RangeError)
  })
})

describe('renderResetReminder', () => {
  it('substitutes the remaining token count', () => {
    expect(renderResetReminder('only {n_remaining} tokens remaining', 1_500)).toBe('only 1500 tokens remaining')
  })

  it('substitutes every occurrence', () => {
    expect(renderResetReminder('{n_remaining} and {n_remaining}', 7)).toBe('7 and 7')
  })
})

describe('assertReminderTemplate', () => {
  it('accepts a template with the placeholder', () => {
    expect(() => assertReminderTemplate('{n_remaining} left')).not.toThrow()
  })

  it('rejects an empty template', () => {
    expect(() => assertReminderTemplate('   ')).toThrow()
  })

  it('rejects a template without the placeholder', () => {
    expect(() => assertReminderTemplate('no placeholder here')).toThrow()
  })
})
