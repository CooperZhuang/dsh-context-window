/**
 * Per-session window bookkeeping, mirroring Codex's `AutoCompactWindow`.
 *
 * A "context window" here is a logical epoch of a session, not the model's
 * capacity: it starts at 1, advances once per reset, and carries the id chain
 * the model is told about (`first` / `previous` / `current`) so it can reason
 * about where the content it remembers came from.
 *
 * The prefill baseline is the load-bearing part. It records the absolute
 * input-token count of the first request in the window; later requests charge
 * only their growth against the budget (`body_after_prefix`). A server-observed
 * sample always wins over an estimate and is never replaced afterwards.
 *
 * Pure and synchronous on purpose: the plugin owns persistence separately, so
 * this class can be unit-tested with an injected id generator.
 *
 * @module dsh-context-window/window-state
 */

/** Where the window baseline came from. */
export type PrefillSource = 'server-observed' | 'estimated'

/** One immutable view of a session's current window. */
export interface WindowSnapshot {
  /** 1-based ordinal of the current window. */
  readonly ordinal: number
  /** Id of the session's first window; stable for the session's life. */
  readonly firstId: string
  /** Id of the window that preceded the current one, when there was one. */
  readonly previousId: string | undefined
  /** Id of the current window. */
  readonly currentId: string
  /** Absolute input-token baseline of the current window, when known. */
  readonly prefillTokens: number | undefined
  /** Whether that baseline was observed from the provider or estimated. */
  readonly prefillSource: PrefillSource | undefined
}

/** Mints window ids; injected so tests stay deterministic. */
export type WindowIdFactory = () => string

/**
 * The default id factory: a UUIDv7-shaped id is unnecessary here (nothing
 * sorts by it), so `crypto.randomUUID()` keeps the dependency surface empty.
 * @returns a fresh opaque window id.
 */
export const defaultWindowIdFactory: WindowIdFactory = () => globalThis.crypto.randomUUID()

/** One session's window state. */
export class WindowState {
  private ordinal = 1
  private firstId: string
  private previousId: string | undefined
  private currentId: string
  private prefillTokens: number | undefined
  private prefillSource: PrefillSource | undefined

  /**
   * @param createId - id factory; defaults to `crypto.randomUUID`.
   */
  constructor(private readonly createId: WindowIdFactory = defaultWindowIdFactory) {
    this.firstId = createId()
    this.currentId = this.firstId
  }

  /** @returns the current immutable window view. */
  snapshot(): WindowSnapshot {
    return Object.freeze({
      ordinal: this.ordinal,
      firstId: this.firstId,
      previousId: this.previousId,
      currentId: this.currentId,
      prefillTokens: this.prefillTokens,
      prefillSource: this.prefillSource,
    })
  }

  /**
   * Advance to a fresh window and drop the baseline with it. The previous
   * window id stays reachable so the notice can name it.
   * @returns the new window's ordinal.
   */
  startNext(): number {
    this.previousId = this.currentId
    this.currentId = this.createId()
    this.ordinal += 1
    this.prefillTokens = undefined
    this.prefillSource = undefined
    return this.ordinal
  }

  /**
   * Record a server-observed baseline. A later estimate never replaces it —
   * provider truth outranks the fixed heuristic.
   * @param tokens - the observed input-token count.
   * @returns whether the baseline changed.
   */
  observePrefill(tokens: number): boolean {
    assertTokens(tokens)
    if (this.prefillSource === 'server-observed') return false
    this.prefillTokens = tokens
    this.prefillSource = 'server-observed'
    return true
  }

  /**
   * Record an estimated baseline, used when no provider usage is available yet
   * (for example after a resume, where the window restarts from a replayed log).
   * @param tokens - the estimated input-token count.
   * @returns whether the baseline changed.
   */
  estimatePrefill(tokens: number): boolean {
    assertTokens(tokens)
    if (this.prefillSource === 'server-observed') return false
    this.prefillTokens = tokens
    this.prefillSource = 'estimated'
    return true
  }

  /** Drop the baseline without advancing the window (a surface replacement). */
  clearPrefill(): void {
    this.prefillTokens = undefined
    this.prefillSource = undefined
  }
}

/**
 * @param tokens - candidate baseline.
 * @throws when the value is not a non-negative finite number.
 */
function assertTokens(tokens: number): void {
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw new RangeError(`context-window: invalid prefill ${String(tokens)} — expected a non-negative finite token count`)
  }
}
