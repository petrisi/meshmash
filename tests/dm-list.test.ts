// Direct message list: pinned order, recency order, and the stored pins and closed threads.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { movePin, orderDms } from '../src/lib/model/dmOrder'
import { loadDmList, saveDmList } from '../src/lib/store/dmList'

describe('orderDms', () => {
  const last: Record<string, number> = { a: 100, b: 300, c: 200, d: 50 }
  const at = (id: string) => last[id]

  it('pinned first in pin order, then newest first', () => {
    expect(orderDms(['a', 'b', 'c', 'd'], ['d', 'a'], at)).toEqual(['d', 'a', 'b', 'c'])
  })
  it('threads without messages first among the unpinned', () => {
    expect(orderDms(['a', 'new', 'b'], [], at)).toEqual(['new', 'b', 'a'])
  })
  it('pins of closed or unknown threads are skipped', () => {
    expect(orderDms(['a', 'b'], ['x', 'b'], at)).toEqual(['b', 'a'])
  })
})

describe('movePin', () => {
  it('moves up and down, clamped', () => {
    expect(movePin(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(movePin(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c'])
    expect(movePin(['a', 'b', 'c'], 'a', 9)).toEqual(['b', 'c', 'a'])
    expect(movePin(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
  })
  it('unknown id leaves the list as is', () => {
    const pins = ['a']
    expect(movePin(pins, 'x', 0)).toBe(pins)
  })
})

describe('dmList store', () => {
  let store: Record<string, string>
  beforeEach(() => {
    store = {}
    Object.assign(globalThis, {
      localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) },
    })
  })
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('round trip per radio', () => {
    saveDmList('r1', { pins: ['b', 'a'], closed: { c: 5 } })
    expect(loadDmList('r1')).toEqual({ pins: ['b', 'a'], closed: { c: 5 } })
    expect(loadDmList('r2')).toEqual({ pins: [], closed: {} })
  })
  it('bad data is dropped', () => {
    store['meshmash.dmList.r'] = '{"pins":["a",1,"a"],"closed":{"b":"x","c":7}}'
    expect(loadDmList('r')).toEqual({ pins: ['a'], closed: { c: 7 } })
    store['meshmash.dmList.r'] = 'not json'
    expect(loadDmList('r')).toEqual({ pins: [], closed: {} })
  })
})
