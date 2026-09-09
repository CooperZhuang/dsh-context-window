/**
 * Plugin configuration, validated at load time by schemastery.
 *
 * Every default mirrors a Codex default so a deployment can compare the two
 * systems knob for knob:
 *
 * | field | Codex equivalent | default |
 * |---|---|---|
 * | `effectiveContextWindowPercent` | `effective_context_window_percent` | 95 |
 * | `autoCompactTokenLimitRatio` | the 90% clamp on `model_auto_compact_token_limit` | 0.9 |
 * | `configuredLimit` | `model_auto_compact_token_limit` | unset |
 * | `fallbackBufferTokens` | `auto_compact_fallback_buffer_tokens` | 8000 |
 * | `noticeThresholds` | `TOKEN_BUDGET_USAGE_THRESHOLDS` | [25, 50, 75] |
 * | `resetReminderTemplate` | `reminder_message_template` | see notice.ts |
 *
 * @module dsh-context-window/config
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_NOTICE_THRESHOLDS } from './emission.ts'
import { DEFAULT_RESET_REMINDER_TEMPLATE } from './notice.ts'

/** Where a reset gets its replacement content. */
export type ResetMode = 'seam-region' | 'handoff'

/** The accepted `resetMode` values, in validation order. */
export const RESET_MODES: readonly ResetMode[] = Object.freeze(['seam-region', 'handoff'])

/** Plugin configuration. */
export interface Config {
  /** Master switch. Off by default: a mounted-but-disabled row changes nothing. */
  enabled: boolean
  /** Whether the model-visible window notice is injected. */
  noticeEnabled: boolean
  /** Consumption percentages that trigger a notice, as integers in `(0, 100]`. */
  noticeThresholds: number[]
  /** Share of the routed context window treated as usable, in percent. */
  effectiveContextWindowPercent: number
  /** Clamp applied to `configuredLimit`, as a fraction of the context window. */
  autoCompactTokenLimitRatio: number
  /** Explicit token limit; unset uses the ratio-derived limit. */
  configuredLimit?: number | undefined
  /** Room reserved below the threshold for the next request's own output. */
  fallbackBufferTokens: number
  /** Pre-reset reminder text; must contain `{n_remaining}`. */
  resetReminderTemplate: string
  /** Emit the pre-reset reminder once remaining tokens fall to or below this. */
  reminderThresholdTokens: number
  /** Charge tokens only above the window baseline (`body_after_prefix`). */
  bodyAfterPrefix: boolean
  /** Whether the model-facing `new_context` tool is registered. */
  toolEnabled: boolean
  /** Name of the model-facing reset tool. */
  toolName: string
  /** How a reset builds the next window's content. */
  resetMode: ResetMode
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  noticeEnabled: z.boolean().default(true),
  noticeThresholds: z.array(z.number()).default([...DEFAULT_NOTICE_THRESHOLDS]),
  effectiveContextWindowPercent: z.number().default(95),
  autoCompactTokenLimitRatio: z.number().default(0.9),
  configuredLimit: z.number(),
  fallbackBufferTokens: z.number().default(8000),
  resetReminderTemplate: z.string().default(DEFAULT_RESET_REMINDER_TEMPLATE),
  reminderThresholdTokens: z.number().default(16_000),
  bodyAfterPrefix: z.boolean().default(true),
  toolEnabled: z.boolean().default(true),
  toolName: z.string().default('new_context'),
  resetMode: z.union(['seam-region', 'handoff'] as const).default('seam-region'),
})

/**
 * Validate the parts schemastery cannot express and fail loud at load time.
 * @param config - the normalized configuration.
 * @throws when a value is out of range or a mode is unknown.
 */
export function assertConfig(config: Config): void {
  if (config.effectiveContextWindowPercent <= 0 || config.effectiveContextWindowPercent > 100) {
    throw new RangeError(`context-window: effectiveContextWindowPercent must be in (0, 100], got ${String(config.effectiveContextWindowPercent)}`)
  }
  if (config.autoCompactTokenLimitRatio <= 0 || config.autoCompactTokenLimitRatio > 1) {
    throw new RangeError(`context-window: autoCompactTokenLimitRatio must be in (0, 1], got ${String(config.autoCompactTokenLimitRatio)}`)
  }
  if (config.fallbackBufferTokens < 0 || !Number.isFinite(config.fallbackBufferTokens)) {
    throw new RangeError(`context-window: fallbackBufferTokens must be a non-negative finite number, got ${String(config.fallbackBufferTokens)}`)
  }
  if (!RESET_MODES.includes(config.resetMode)) {
    throw new TypeError(`context-window: resetMode must be one of ${RESET_MODES.join(' | ')}, got ${JSON.stringify(config.resetMode)}`)
  }
  if (config.toolEnabled && config.toolName.trim() === '') {
    throw new TypeError('context-window: toolName must not be empty when the reset tool is enabled')
  }
}
