import { describe, expect, it } from 'vitest'
import { NoticeThrottle, normalizeNoticeThresholds } from '../src/emission.ts'
import { assertConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'

describe('normalizeNoticeThresholds', () => {
  it('sorts and de-duplicates', () => {
    expect(normalizeNoticeThresholds([75, 25, 75, 50])).toEqual([25, 50, 75])
  })

  it('rejects a value outside (0, 100]', () => {
    expect(() => normalizeNoticeThresholds([0])).toThrow(RangeError)
    expect(() => normalizeNoticeThresholds([101])).toThrow(RangeError)
  })
})

describe('NoticeThrottle', () => {
  it('claims each crossed threshold exactly once', () => {
    const throttle = new NoticeThrottle([25, 50, 75])
    expect(throttle.claim(30)).toEqual([25])
    expect(throttle.claim(30)).toEqual([])
    expect(throttle.claim(80)).toEqual([50, 75])
    expect(throttle.claim(100)).toEqual([])
  })

  it('starts over after a reset', () => {
    const throttle = new NoticeThrottle([25, 50, 75])
    throttle.claim(80)
    throttle.reset()
    expect(throttle.claim(80)).toEqual([25, 50, 75])
  })

  it('rejects a non-finite percentage', () => {
    expect(() => new NoticeThrottle([25]).claim(Number.NaN)).toThrow(RangeError)
  })
})

describe('assertConfig', () => {
  const base: Config = {
    enabled: true,
    noticeEnabled: true,
    noticeThresholds: [25, 50, 75],
    effectiveContextWindowPercent: 95,
    autoCompactTokenLimitRatio: 0.9,
    fallbackBufferTokens: 8_000,
    resetReminderTemplate: '{n_remaining} left',
    reminderThresholdTokens: 16_000,
    bodyAfterPrefix: true,
    toolEnabled: true,
    toolName: 'new_context',
    resetMode: 'seam-region',
  }

  it('accepts the shipped defaults', () => {
    expect(() => assertConfig(base)).not.toThrow()
  })

  it('rejects an out-of-range effective percentage', () => {
    expect(() => assertConfig({ ...base, effectiveContextWindowPercent: 0 })).toThrow(RangeError)
    expect(() => assertConfig({ ...base, effectiveContextWindowPercent: 101 })).toThrow(RangeError)
  })

  it('rejects an out-of-range clamp ratio', () => {
    expect(() => assertConfig({ ...base, autoCompactTokenLimitRatio: 1.5 })).toThrow(RangeError)
  })

  it('rejects a negative fallback buffer', () => {
    expect(() => assertConfig({ ...base, fallbackBufferTokens: -1 })).toThrow(RangeError)
  })

  it('rejects an unknown reset mode', () => {
    expect(() => assertConfig({ ...base, resetMode: 'summarize' as Config['resetMode'] })).toThrow(TypeError)
  })

  it('rejects an empty tool name while the tool is enabled', () => {
    expect(() => assertConfig({ ...base, toolName: '  ' })).toThrow(TypeError)
  })
})
