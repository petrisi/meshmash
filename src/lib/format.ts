import type { Position } from './model/types'

export function ago(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '—'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}

export function dayLabel(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yest = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yest.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}

export function uptime(s: number | undefined): string {
  if (s === undefined) return '—'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}

export function distanceKm(a?: Position, b?: Position): number | undefined {
  if (!a || !b) return undefined
  const R = 6371
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export function km(d: number | undefined): string {
  if (d === undefined) return '—'
  return d < 10 ? d.toFixed(1) : Math.round(d).toString()
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** User-perceived characters; an emoji with modifiers/ZWJ counts as one. */
export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (g) => g.segment)
}

const EMOJI = /\p{Extended_Pictographic}/u

/** Badge text for protocols without short names: leading emoji, else initials. */
export function initials(name: string, max = 2): string {
  const g = graphemes(name.trim())
  if (g.length && EMOJI.test(g[0])) return g[0]
  const words = name.split(/\s+/).filter((w) => w && !EMOJI.test(w))
  const s = words.length > 1 ? words.map((w) => graphemes(w)[0]).join('') : (words[0] ?? '?')
  return graphemes(s).slice(0, max).join('').toUpperCase()
}

/** Stable hue per node id for badges. */
export function hue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 360
}

/** Signal quality bucket from SNR (dB), roughly LoRa-decodable range. */
export function snrClass(snr: number | undefined): string {
  if (snr === undefined) return ''
  if (snr >= 0) return 'good'
  if (snr >= -10) return 'fair'
  return 'poor'
}
