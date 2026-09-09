import { describe, expect, it } from 'vitest'
import {
  bodyAfterPrefix,
  resolveAutoCompactLimit,
  resolveBudget,
  usableContextWindow,
} from '../src/budget.ts'

describe('usableContextWindow', () => {
  it('reserves the tail of the window, matching Codex 95%', () => {
    expect(usableContextWindow(128_000, 95)).toBe(121_600)
  })

  it('floors fractional results', () => {
    expect(usableContextWindow(1_001, 95)).toBe(950)
  })

  it('rejects a non-positive capacity', () => {
    expect(() => usableContextWindow(0, 95)).toThrow(RangeError)
  })

  it('rejects a percentage outside (0, 100]', () => {
    expect(() => usableContextWindow(1_000, 0)).toThrow(RangeError)
    expect(() => usableContextWindow(1_000, 101)).toThrow(RangeError)
  })
})

describe('resolveAutoCompactLimit', () => {
  it('derives 90% of the window when no explicit limit is configured', () => {
    expect(resolveAutoCompactLimit(undefined, 128_000, 0.9)).toBe(115_200)
  })

  it('clamps an explicit limit to the ratio-derived ceiling', () => {
    expect(resolveAutoCompactLimit(500_000, 128_000, 0.9)).toBe(115_200)
  })

  it('keeps an explicit limit below the ceiling', () => {
    expect(resolveAutoCompactLimit(20_000, 128_000, 0.9)).toBe(20_000)
  })
})

describe('bodyAfterPrefix', () => {
  it('charges the whole measurement when no baseline is known (total scope)', () => {
    expect(bodyAfterPrefix(9_000, undefined)).toBe(9_000)
  })

  it('charges only growth above the baseline (body_after_prefix scope)', () => {
    expect(bodyAfterPrefix(9_000, 8_000)).toBe(1_000)
  })

  it('never goes negative when the measurement falls below the baseline', () => {
    expect(bodyAfterPrefix(7_000, 8_000)).toBe(0)
  })
})

describe('resolveBudget', () => {
  const policy = {
    effectivePercent: 95,
    autoCompactRatio: 0.9,
    fallbackBufferTokens: 8_000,
  } as const

  it('does not reset while the charged body stays below the threshold', () => {
    const snapshot = resolveBudget({
      ...policy,
      contextWindow: 128_000,
      usedTokens: 50_000,
      baselinePrefillTokens: 40_000,
    })
    expect(snapshot.chargedTokens).toBe(10_000)
    expect(snapshot.thresholdTokens).toBe(121_600)
    expect(snapshot.remainingTokens).toBe(111_600)
    expect(snapshot.shouldReset).toBe(false)
  })

  it('resets once the charged body reaches the threshold', () => {
    const snapshot = resolveBudget({
      ...policy,
      contextWindow: 128_000,
      usedTokens: 130_000,
      baselinePrefillTokens: 0,
    })
    expect(snapshot.thresholdTokens).toBe(121_600)
    expect(snapshot.shouldReset).toBe(true)
    expect(snapshot.remainingTokens).toBe(0)
  })

  it('clamps the threshold to the usable window so a huge buffer cannot exceed it', () => {
    const snapshot = resolveBudget({
      ...policy,
      fallbackBufferTokens: 10_000_000,
      contextWindow: 128_000,
      usedTokens: 1,
    })
    expect(snapshot.thresholdTokens).toBe(snapshot.usableTokens)
  })

  it('treats the total scope as a zero baseline', () => {
    const withBaseline = resolveBudget({ ...policy, contextWindow: 10_000, usedTokens: 9_000, baselinePrefillTokens: 0 })
    const withoutBaseline = resolveBudget({ ...policy, contextWindow: 10_000, usedTokens: 9_000 })
    expect(withBaseline.chargedTokens).toBe(withoutBaseline.chargedTokens)
  })
})
