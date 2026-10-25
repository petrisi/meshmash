import { describe, expect, it } from 'vitest'
import { ago, battery, clock, dayLabel, distanceErrKm, distanceKm, graphemes, hue, initials, km, snrClass, uptime } from '../src/lib/format'

describe('format', () => {
  it('ago', () => {
    const now = 1_700_000_000_000
    expect(ago(undefined, now)).toBe('—')
    expect(ago(0, now)).toBe('—')
    expect(ago(now + 5000, now)).toBe('0s')
    expect(ago(now - 59_000, now)).toBe('59s')
    expect(ago(now - 60_000, now)).toBe('1m')
    expect(ago(now - 3_599_000, now)).toBe('59m')
    expect(ago(now - 7_200_000, now)).toBe('2h')
    expect(ago(now - 3 * 86_400_000, now)).toBe('3d')
  })

  it('uptime', () => {
    expect(uptime(undefined)).toBe('—')
    expect(uptime(59)).toBe('0m')
    expect(uptime(3 * 60)).toBe('3m')
    expect(uptime(3600 + 120)).toBe('1h 2m')
    expect(uptime(2 * 86400 + 5 * 3600 + 7)).toBe('2d 5h')
  })

  it('distanceKm and km', () => {
    expect(distanceKm(undefined, { lat: 0, lon: 0 })).toBeUndefined()
    expect(distanceKm({ lat: 1, lon: 1 }, { lat: 1, lon: 1 })).toBe(0)
    // One degree of latitude is ~111.2 km.
    expect(distanceKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111.19, 1)
    // Antimeridian crossing is short.
    expect(distanceKm({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 })!).toBeLessThan(112)
    expect(km(undefined)).toBe('—')
    expect(km(3.14159)).toBe('3.1')
    expect(km(10.4)).toBe('10')
    expect(km(123.6)).toBe('124')
  })

  it('marks distances from coarse positions with a tilde', () => {
    // Below display resolution: unchanged.
    expect(km(7.63, 0.023)).toBe('7.6')
    expect(km(12.4, 0.3)).toBe('12')
    // Beyond it: tilde, whole km once the error reaches 0.5 km.
    expect(km(7.63, 0.2)).toBe('~7.6')
    expect(km(7.63, 2.9)).toBe('~8')
    expect(km(11.2, 2.9)).toBe('~11')
    expect(distanceErrKm({ lat: 61, lon: 23 }, { lat: 61, lon: 23, precisionBits: 13 })).toBeCloseTo(2.918, 2)
    expect(distanceErrKm({ lat: 61, lon: 23 }, undefined)).toBe(0)
  })

  it('graphemes and initials', () => {
    expect(graphemes('a👍🏽b👨‍👩‍👧')).toEqual(['a', '👍🏽', 'b', '👨‍👩‍👧'])
    expect(initials('alice bob carol')).toBe('AB')
    expect(initials('alice bob carol', 3)).toBe('ABC')
    expect(initials('zeta')).toBe('ZE')
    expect(initials('🐸 frog pond')).toBe('🐸')
    expect(initials('frog 🐸 pond')).toBe('FP')
    expect(initials('  ')).toBe('?')
    expect(initials('ébène örn')).toBe('ÉÖ')
  })

  it('battery, hue, snrClass', () => {
    expect(battery(undefined)).toBe('')
    expect(battery(55)).toBe('55%')
    expect(battery(101)).toBe('ext power')
    expect(hue('!abcdef01')).toBe(hue('!abcdef01'))
    for (const id of ['', 'a', '!00000000', 'x'.repeat(100)]) {
      const h = hue(id)
      expect(Number.isInteger(h) && h >= 0 && h < 360).toBe(true)
    }
    expect(snrClass(undefined)).toBe('')
    expect(snrClass(5)).toBe('good')
    expect(snrClass(0)).toBe('good')
    expect(snrClass(-10)).toBe('fair')
    expect(snrClass(-10.25)).toBe('poor')
  })

  it('clock and dayLabel', () => {
    expect(clock(Date.now())).toMatch(/\d{1,2}\D\d{2}/)
    expect(dayLabel(Date.now())).toBe('Today')
    // Calendar days: a day with a DST change is 23 or 25 hours long.
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    expect(dayLabel(yesterday.getTime())).toBe('Yesterday')
    expect(dayLabel(Date.now() - 10 * 86_400_000)).not.toMatch(/Today|Yesterday/)
  })
})
