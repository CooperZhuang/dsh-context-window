/**
 * Notice throttling, mirroring Codex's threshold-claim model.
 *
 * Codex emits the budget notice once when the window opens and then once per
 * 25% / 50% / 75% of consumption, never per turn — an every-turn notice would
 * rewrite the request prefix and destroy prompt-cache reuse for no gain. This
 * module is the pure decision half of that rule: the plugin owns the per-window
 * state, this owns the arithmetic.
 *
 * @module dsh-context-window/emission
 */

/** Default consumption percentages that trigger a notice. */
export const DEFAULT_NOTICE_THRESHOLDS: readonly number[] = Object.freeze([25, 50, 75])

/**
 * Validate a configured threshold list.
 * @param thresholds - candidate percentages.
 * @returns the thresholds sorted ascending and de-duplicated.
 * @throws when any value is not an integer in `(0, 100]`.
 */
export function normalizeNoticeThresholds(thresholds: readonly number[]): number[] {
  for (const value of thresholds) {
    if (!Number.isInteger(value) || value <= 0 || value > 100) {
      throw new RangeError(`context-window: invalid notice threshold ${String(value)} — expected an integer in (0, 100]`)
    }
  }
  return [...new Set(thresholds)].sort((a, b) => a - b)
}

/**
 * Tracks which consumption thresholds a single window has already reported.
 * One instance per window; {@link reset} is called when the window advances.
 */
export class NoticeThrottle {
  private readonly claimed = new Set<number>()

  /**
   * @param thresholds - normalized consumption percentages.
   */
  constructor(private readonly thresholds: readonly number[]) {}

  /**
   * Claim every threshold the current consumption has crossed since the last
   * call, in ascending order.
   * @param consumedPercent - consumption of the usable window, in percent.
   * @returns the newly crossed thresholds; empty when nothing new is due.
   */
  claim(consumedPercent: number): number[] {
    if (!Number.isFinite(consumedPercent)) {
      throw new RangeError(`context-window: invalid consumedPercent ${String(consumedPercent)}`)
    }
    const crossed: number[] = []
    for (const threshold of this.thresholds) {
      if (consumedPercent >= threshold && !this.claimed.has(threshold)) {
        this.claimed.add(threshold)
        crossed.push(threshold)
      }
    }
    return crossed
  }

  /** Drop every claim so a fresh window starts over. */
  reset(): void {
    this.claimed.clear()
  }
}
