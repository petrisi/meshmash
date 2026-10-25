import { describe, expect, it } from 'vitest'
import { hopSuggestion } from '../src/lib/model/hops'

describe('hopSuggestion', () => {
  it('suggests the distance when it exceeds the limit', () => {
    expect(hopSuggestion(3, 6)).toBe(6)
  })
  it('stays quiet when the limit reaches or the distance is unknown', () => {
    expect(hopSuggestion(3, 3)).toBeUndefined()
    expect(hopSuggestion(3, 0)).toBeUndefined()
    expect(hopSuggestion(3, undefined)).toBeUndefined()
    expect(hopSuggestion(7, 7)).toBeUndefined()
  })
  it('caps at 7', () => {
    expect(hopSuggestion(3, 9)).toBe(7)
  })
})
