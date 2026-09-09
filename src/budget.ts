/**
 * Codex-parity context budgeting math, kept pure so it is unit-testable
 * without a session, a model route, or a token meter.
 *
 * Four numbers drive the whole feature:
 *
 * ```text
 * usable    = floor(contextWindow * effectivePercent / 100)      // 95 by default
 * limit     = min(configuredLimit, floor(contextWindow * ratio)) // 90% hard clamp
 * charged   = usedTokens - baselinePrefillTokens                 // body_after_prefix
 * threshold = min(limit + fallbackBufferTokens, usable)
 * ```
 *
 * `baselinePrefillTokens` is the absolute input-token count observed (or
 * estimated) at the start of the current window. Charging only the growth after
 * that baseline is Codex's `body_after_prefix` scope: a large system prompt or
 * tool catalog stops consuming budget it did not grow. With no baseline the
 * scope degenerates to `total`, which is DSH's shipped behaviour.
 *
 * @module dsh-context-window/budget
 */

/** Policy knobs shared by every model route, mirroring Codex's config surface. */
export interface BudgetPolicy {
  /** Share of the routed context window treated as usable, in percent (Codex: 95). */
  readonly effectivePercent: number
  /** Share of the context window the reset limit is clamped to (Codex: 90%). */
  readonly autoCompactRatio: number
  /** Room reserved below the threshold for the next request's own output. */
  readonly fallbackBufferTokens: number
  /** Explicit token limit; when omitted the ratio-derived limit is used. */
  readonly configuredLimit?: number | undefined
}

/** One budgeting question: how full is this route's window, and should it reset? */
export interface BudgetInputs extends BudgetPolicy {
  /** Adapter-owned capacity for the routed model, in tokens. */
  readonly contextWindow: number
  /** Current measured request-and-response pressure, in tokens. */
  readonly usedTokens: number
  /**
   * Absolute input-token baseline for the current window. Omit for `total`
   * scope; supply it for `body_after_prefix` scope.
   */
  readonly baselinePrefillTokens?: number | undefined
}

/** The resolved figures a notice or a reset decision reads. */
export interface BudgetSnapshot {
  readonly contextWindow: number
  /** Capacity treated as usable after `effectivePercent`. */
  readonly usableTokens: number
  /** Ratio- or config-derived reset limit before the fallback buffer. */
  readonly limitTokens: number
  /** Tokens charged against the limit under the configured scope. */
  readonly chargedTokens: number
  /** Effective reset threshold, already clamped to the usable window. */
  readonly thresholdTokens: number
  /** Tokens left before the usable window is exhausted; never negative. */
  readonly remainingTokens: number
  /** `remainingTokens` as a percentage of the usable window, rounded. */
  readonly remainingPercent: number
  /** Whether the charged body has reached the reset threshold. */
  readonly shouldReset: boolean
}

/**
 * Validate one capacity figure and fail loud on a value no policy can use.
 * @param contextWindow - adapter-owned capacity in tokens.
 * @returns the same value, narrowed to a positive finite integer.
 */
export function assertContextWindow(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new RangeError(`context-window: invalid contextWindow ${String(contextWindow)} — expected a positive finite token count`)
  }
  return contextWindow
}

/**
 * Capacity treated as usable. Codex reserves the tail of the window for its own
 * request overhead, so a 128k route budgets against 121.6k by default.
 * @param contextWindow - adapter-owned capacity in tokens.
 * @param effectivePercent - share treated as usable, in percent.
 * @returns the floored usable capacity.
 */
export function usableContextWindow(contextWindow: number, effectivePercent: number): number {
  assertContextWindow(contextWindow)
  if (!Number.isFinite(effectivePercent) || effectivePercent <= 0 || effectivePercent > 100) {
    throw new RangeError(`context-window: invalid effectivePercent ${String(effectivePercent)} — expected a number in (0, 100]`)
  }
  return Math.floor((contextWindow * effectivePercent) / 100)
}

/**
 * The configured limit, clamped to its share of the window. Codex caps a
 * user-supplied `model_auto_compact_token_limit` at 90% of the window so a
 * stale absolute value cannot outlive a smaller model switch.
 * @param configuredLimit - explicit limit, or `undefined` for the ratio only.
 * @param contextWindow - adapter-owned capacity in tokens.
 * @param autoCompactRatio - clamp ratio in `(0, 1]`.
 * @returns the effective limit before the fallback buffer.
 */
export function resolveAutoCompactLimit(
  configuredLimit: number | undefined,
  contextWindow: number,
  autoCompactRatio: number,
): number {
  assertContextWindow(contextWindow)
  if (!Number.isFinite(autoCompactRatio) || autoCompactRatio <= 0 || autoCompactRatio > 1) {
    throw new RangeError(`context-window: invalid autoCompactRatio ${String(autoCompactRatio)} — expected a number in (0, 1]`)
  }
  const clamped = Math.floor(contextWindow * autoCompactRatio)
  if (configuredLimit === undefined) return clamped
  if (!Number.isFinite(configuredLimit) || configuredLimit <= 0) {
    throw new RangeError(`context-window: invalid configuredLimit ${String(configuredLimit)} — expected a positive finite token count`)
  }
  return Math.min(configuredLimit, clamped)
}

/**
 * Tokens charged against the limit under the configured scope.
 * @param usedTokens - current measured pressure in tokens.
 * @param baselinePrefillTokens - window baseline, or `undefined` for `total` scope.
 * @returns the charged body, never negative.
 */
export function bodyAfterPrefix(usedTokens: number, baselinePrefillTokens: number | undefined): number {
  if (!Number.isFinite(usedTokens) || usedTokens < 0) {
    throw new RangeError(`context-window: invalid usedTokens ${String(usedTokens)} — expected a non-negative finite token count`)
  }
  if (baselinePrefillTokens === undefined) return usedTokens
  if (!Number.isFinite(baselinePrefillTokens) || baselinePrefillTokens < 0) {
    throw new RangeError(`context-window: invalid baselinePrefillTokens ${String(baselinePrefillTokens)} — expected a non-negative finite token count`)
  }
  return Math.max(0, usedTokens - baselinePrefillTokens)
}

/**
 * Resolve every figure a notice or reset decision needs.
 * @param inputs - capacity, measurement, scope baseline, and policy.
 * @returns an immutable snapshot of the resolved budget.
 */
export function resolveBudget(inputs: BudgetInputs): BudgetSnapshot {
  const { contextWindow, usedTokens, baselinePrefillTokens } = inputs
  const usableTokens = usableContextWindow(contextWindow, inputs.effectivePercent)
  const limitTokens = resolveAutoCompactLimit(inputs.configuredLimit, contextWindow, inputs.autoCompactRatio)
  const chargedTokens = bodyAfterPrefix(usedTokens, baselinePrefillTokens)
  const thresholdTokens = Math.min(limitTokens + inputs.fallbackBufferTokens, usableTokens)
  const remainingTokens = Math.max(0, usableTokens - chargedTokens)
  return Object.freeze({
    contextWindow,
    usableTokens,
    limitTokens,
    chargedTokens,
    thresholdTokens,
    remainingTokens,
    remainingPercent: usableTokens === 0 ? 0 : Math.round((remainingTokens / usableTokens) * 100),
    shouldReset: chargedTokens >= thresholdTokens,
  })
}
