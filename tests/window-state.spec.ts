import { describe, expect, it } from 'vitest'
import { WindowState } from '../src/window-state.ts'

function ids(...values: string[]): () => string {
  let index = 0
  return () => {
    const value = values[index]
    index += 1
    if (value === undefined) throw new Error('id factory exhausted')
    return value
  }
}

describe('WindowState', () => {
  it('starts at ordinal 1 with the first id as the current id', () => {
    const state = new WindowState(ids('w1'))
    expect(state.snapshot()).toEqual({
      ordinal: 1,
      firstId: 'w1',
      previousId: undefined,
      currentId: 'w1',
      prefillTokens: undefined,
      prefillSource: undefined,
    })
  })

  it('advances the ordinal and links the previous id', () => {
    const state = new WindowState(ids('w1', 'w2'))
    expect(state.startNext()).toBe(2)
    expect(state.snapshot()).toEqual({
      ordinal: 2,
      firstId: 'w1',
      previousId: 'w1',
      currentId: 'w2',
      prefillTokens: undefined,
      prefillSource: undefined,
    })
  })

  it('drops the baseline when the window advances', () => {
    const state = new WindowState(ids('w1', 'w2'))
    state.estimatePrefill(1_000)
    state.startNext()
    expect(state.snapshot().prefillTokens).toBeUndefined()
  })

  it('lets a server-observed baseline win over a later estimate', () => {
    const state = new WindowState(ids('w1'))
    expect(state.estimatePrefill(900)).toBe(true)
    expect(state.observePrefill(1_200)).toBe(true)
    expect(state.snapshot()).toMatchObject({ prefillTokens: 1_200, prefillSource: 'server-observed' })

    expect(state.estimatePrefill(50)).toBe(false)
    expect(state.snapshot().prefillTokens).toBe(1_200)
  })

  it('keeps the first observed baseline when a second sample arrives', () => {
    const state = new WindowState(ids('w1'))
    state.observePrefill(1_200)
    expect(state.observePrefill(1_300)).toBe(false)
    expect(state.snapshot().prefillTokens).toBe(1_200)
  })

  it('clears the baseline without advancing the window', () => {
    const state = new WindowState(ids('w1'))
    state.observePrefill(1_200)
    state.clearPrefill()
    expect(state.snapshot()).toMatchObject({ ordinal: 1, prefillTokens: undefined, prefillSource: undefined })
  })

  it('rejects a negative baseline', () => {
    const state = new WindowState(ids('w1'))
    expect(() => state.estimatePrefill(-1)).toThrow(RangeError)
  })
})
