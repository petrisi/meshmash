// Activity chart buckets: edges in local time, counts by direction, filters, coverage.
import { describe, expect, it } from 'vitest'
import { activity, bucketEdges, coveredMs, niceScale, type PacketRecord, timeOfDay } from '../src/lib/model/analytics'

const H = 3_600_000
const NOW = new Date(2026, 10, 12, 14, 25).getTime()
const all = { types: null, repeats: false }

describe('bucketEdges', () => {
  it('24 h: hourly, ending at the next full hour', () => {
    const e = bucketEdges('24h', NOW)
    expect(e).toHaveLength(25)
    expect(e.at(-1)).toBe(new Date(2026, 10, 12, 15).getTime())
    expect(e[1] - e[0]).toBe(H)
  })
  it('7 days: 168 hourly buckets', () => {
    expect(bucketEdges('7d', NOW)).toHaveLength(169)
  })
  it('30 days: local midnights, ending tomorrow', () => {
    const e = bucketEdges('30d', NOW)
    expect(e).toHaveLength(31)
    expect(e.at(-1)).toBe(new Date(2026, 10, 13).getTime())
    expect(e[0]).toBe(new Date(2026, 9, 14).getTime())
    expect(e.every((t) => new Date(t).getHours() === 0)).toBe(true)
  })
})

describe('activity', () => {
  const recs: PacketRecord[] = [
    { ts: NOW - 10 * 60_000, dir: 'rx', type: 'text' },
    { ts: NOW - 20 * 60_000, dir: 'rx', type: 'position' },
    { ts: NOW - 20 * 60_000, dir: 'rx', type: 'position', dup: true },
    { ts: NOW - 5 * 60_000, dir: 'tx', type: 'text' },
    { ts: NOW - 3 * H, dir: 'rx', type: 'text' },
    { ts: NOW - 30 * H, dir: 'rx', type: 'text' }, // outside 24 h
  ]
  it('counts received and sent per bucket; repeats left out', () => {
    const b = activity(recs, [], '24h', NOW, all)
    expect(b.at(-1)).toMatchObject({ rx: 2, tx: 1 })
    expect(b.at(-4)).toMatchObject({ rx: 1, tx: 0 })
    expect(b.reduce((s, x) => s + x.rx, 0)).toBe(3)
  })
  it('filters by type and includes repeats on request', () => {
    expect(activity(recs, [], '24h', NOW, { types: new Set(['position']), repeats: false }).at(-1)).toMatchObject({ rx: 1, tx: 0 })
    expect(activity(recs, [], '24h', NOW, { types: new Set(['position']), repeats: true }).at(-1)).toMatchObject({ rx: 2 })
  })
  it('connected time per bucket, current bucket up to now', () => {
    const b = activity([], [{ start: NOW - 90 * 60_000, end: NOW + H }], '24h', NOW, all)
    expect(b.at(-1)!.coveredMs).toBe(25 * 60_000)
    expect(b.at(-2)!.coveredMs).toBe(H)
    expect(b.at(-3)!.coveredMs).toBe(5 * 60_000)
    expect(b.at(-4)!.coveredMs).toBe(0)
  })
})

describe('coveredMs', () => {
  it('sums overlaps of several spans', () => {
    expect(coveredMs([{ start: 0, end: 10 }, { start: 20, end: 40 }], 5, 30)).toBe(15)
  })
})

describe('niceScale', () => {
  it('whole-number steps for about four gridlines', () => {
    expect(niceScale(0)).toEqual({ top: 4, step: 1 })
    expect(niceScale(3)).toEqual({ top: 3, step: 1 })
    expect(niceScale(37)).toEqual({ top: 40, step: 10 })
    expect(niceScale(130)).toEqual({ top: 150, step: 50 })
  })
})

describe('timeOfDay', () => {
  // Thu 12 Nov 2026 and Sat 14 Nov 2026, local time.
  const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime()
  const recs: PacketRecord[] = [
    { ts: at(12, 9, 10), dir: 'rx', type: 'text' },
    { ts: at(12, 9, 50), dir: 'tx', type: 'text' },
    { ts: at(14, 9, 20), dir: 'rx', type: 'text', queued: true },
    { ts: at(14, 21, 5), dir: 'rx', type: 'position' },
  ]
  const spans = [
    { start: at(12, 8, 30), end: at(12, 10, 0) }, // Thu 8:30–10:00
    { start: at(14, 9, 0), end: at(14, 9, 30) }, // Sat 9:00–9:30
  ]
  it('counts by local hour; held packets in totals only', () => {
    const t = timeOfDay(recs, spans, all, 'all')
    expect(t[9]).toMatchObject({ rx: 2, tx: 1, rxLive: 1, txLive: 1, coveredMs: 90 * 60_000, days: 2 })
    expect(t[8]).toMatchObject({ rx: 0, coveredMs: 30 * 60_000, days: 1 })
    expect(t[21]).toMatchObject({ rx: 1, coveredMs: 0, days: 0 })
  })
  it('weekdays and weekends', () => {
    expect(timeOfDay(recs, spans, all, 'weekdays')[9]).toMatchObject({ rx: 1, tx: 1, coveredMs: H, days: 1 })
    expect(timeOfDay(recs, spans, all, 'weekends')[9]).toMatchObject({ rx: 1, tx: 0, coveredMs: 30 * 60_000, days: 1 })
  })
})
