import { describe, expect, it } from 'vitest'
import { fit, placeLabels, precisionRadiusM, project, pxPerMetre, spread, unproject, validPosition } from '../src/lib/map/geo'
import { decodePosition, inferPrecisionBits } from '../src/lib/protocol/meshtastic/codec'
import { PbWriter } from '../src/lib/protocol/protobuf'

describe('projection', () => {
  it('round-trips at fractional zooms', () => {
    for (const z of [2, 7.3, 15.5])
      for (const p of [{ lat: 61.5, lon: 23.8 }, { lat: -33.9, lon: 151.2 }, { lat: 0, lon: -179.9 }]) {
        const back = unproject(project(p, z), z)
        expect(back.lat).toBeCloseTo(p.lat, 6)
        expect(back.lon).toBeCloseTo(p.lon, 6)
      }
  })
  it('puts lon 0, lat 0 in the middle of the world', () => {
    expect(project({ lat: 0, lon: 0 }, 1)).toEqual({ x: 256, y: 256 })
  })
})

describe('fit', () => {
  it('contains every point with padding', () => {
    const pts = [
      { lat: 61.40, lon: 23.70 },
      { lat: 61.55, lon: 23.95 },
      { lat: 61.47, lon: 23.60 },
    ]
    const v = fit(pts, 800, 600, 40)!
    const c = project(v.center, v.zoom)
    for (const p of pts) {
      const s = project(p, v.zoom)
      expect(Math.abs(s.x - c.x)).toBeLessThanOrEqual(400 - 40 + 1e-6)
      expect(Math.abs(s.y - c.y)).toBeLessThanOrEqual(300 - 40 + 1e-6)
    }
  })
  it('caps the zoom for a single point', () => {
    expect(fit([{ lat: 61.5, lon: 23.8 }], 800, 600, 40, 15)!.zoom).toBe(15)
  })
  it('returns null without points or size', () => {
    expect(fit([], 800, 600)).toBeNull()
    expect(fit([{ lat: 1, lon: 1 }], 0, 600)).toBeNull()
  })
})

describe('position precision', () => {
  it('is half a cell of 2^(32-bits) * 1e-7 degrees', () => {
    // 13 bits: the Meshtastic app's "~ 1.5 km" setting.
    expect(precisionRadiusM(13)).toBeCloseTo(2 ** 18 * 1e-7 * 111_320, 3)
    expect(precisionRadiusM(13)).toBeGreaterThan(2000)
    expect(precisionRadiusM(13)).toBeLessThan(3500)
  })
  it('is exact for 32 bits or unset', () => {
    expect(precisionRadiusM(32)).toBe(0)
    expect(precisionRadiusM(undefined)).toBe(0)
  })
  it('is decoded from Position field 23', () => {
    const b = new PbWriter().fixed32(1, 614_400_000).fixed32(2, 238_000_000).uint(23, 16).finish()
    expect(decodePosition(b)).toMatchObject({ precisionBits: 16 })
  })
  it('scales to pixels with latitude and zoom', () => {
    expect(pxPerMetre(0, 1) * 2).toBeCloseTo(pxPerMetre(0, 2), 9)
    expect(pxPerMetre(60, 10)).toBeCloseTo(2 * pxPerMetre(0, 10), 6)
  })
})

describe('validPosition', () => {
  it('rejects missing and off-globe coordinates', () => {
    expect(validPosition({ lat: 61, lon: 23 })).toBe(true)
    expect(validPosition(undefined)).toBe(false)
    expect(validPosition({ lat: 91, lon: 0 })).toBe(false)
    expect(validPosition({ lat: 0, lon: Infinity })).toBe(false)
    expect(validPosition({ lat: NaN, lon: 0 })).toBe(false)
  })
})

describe('spread', () => {
  it('moves only markers that share a spot, onto a ring', () => {
    const off = spread([
      { x: 100, y: 100 },
      { x: 101, y: 100 },
      { x: 100, y: 102 },
      { x: 300, y: 300 },
    ])
    expect(off[3]).toEqual({ x: 0, y: 0 })
    const moved = off.slice(0, 3)
    for (const o of moved) expect(Math.hypot(o.x, o.y)).toBeCloseTo(12, 6)
    expect(new Set(moved.map((o) => `${o.x.toFixed(1)},${o.y.toFixed(1)}`)).size).toBe(3)
  })
})

describe('placeLabels', () => {
  it('keeps labels in order unless they overlap a kept label or obstacle', () => {
    const kept = placeLabels(
      [
        { x: 0, y: 0, w: 50, h: 10 },
        { x: 40, y: 5, w: 50, h: 10 },
        { x: 0, y: 20, w: 50, h: 10 },
        { x: 200, y: 0, w: 50, h: 10 },
      ],
      [{ x: 210, y: 2, w: 5, h: 5 }],
    )
    expect([...kept]).toEqual([0, 2])
  })
  it('always keeps the forced leading labels', () => {
    const kept = placeLabels([{ x: 0, y: 0, w: 50, h: 10 }, { x: 10, y: 0, w: 50, h: 10 }], [{ x: 0, y: 0, w: 5, h: 5 }], 1)
    expect([...kept]).toEqual([0])
  })
})

describe('inferPrecisionBits', () => {
  // PositionPrecision.cpp truncateCoordinate
  const truncate = (v: number, bits: number) => {
    const i = Math.round(v * 1e7) | 0
    const t = ((i & (0xffffffff << (32 - bits))) + 2 ** (31 - bits)) | 0
    return t * 1e-7
  }
  it('recovers the bits from a truncated position', () => {
    for (const bits of [10, 13, 16, 19, 23])
      for (const [lat, lon] of [[61.4420123, 23.8150456], [-33.8688197, 151.2092955], [0.5, -0.25]])
        expect(inferPrecisionBits(truncate(lat, bits), truncate(lon, bits))).toBe(bits)
  })
  it('leaves exact positions alone', () => {
    expect(inferPrecisionBits(61.4420123, 23.8150456)).toBeUndefined()
    expect(inferPrecisionBits(61.4290001, 23.786)).toBeUndefined()
  })
})
