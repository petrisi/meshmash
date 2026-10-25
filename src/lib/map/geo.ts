// Web Mercator math for the map: world pixel coordinates at a (fractional) zoom, fitting,
// position precision, and screen-space layout of markers and labels.
import type { Position } from '../model/types'

export const TILE = 256
export const MIN_ZOOM = 2
/** OpenStreetMap standard tiles go to 19. */
export const MAX_ZOOM = 19
const MAX_LAT = 85.0511

export interface LatLon {
  lat: number
  lon: number
}

export interface Point {
  x: number
  y: number
}

export const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))

/** World pixel coordinates at zoom z (fractional zooms scale continuously). */
export function project(p: LatLon, z: number): Point {
  const world = TILE * 2 ** z
  const lat = (Math.max(-MAX_LAT, Math.min(MAX_LAT, p.lat)) * Math.PI) / 180
  return {
    x: ((p.lon + 180) / 360) * world,
    y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * world,
  }
}

export function unproject(pt: Point, z: number): LatLon {
  const world = TILE * 2 ** z
  const lon = (pt.x / world) * 360 - 180
  const n = Math.PI * (1 - (2 * pt.y) / world)
  return { lat: (Math.atan(Math.sinh(n)) * 180) / Math.PI, lon: ((((lon + 180) % 360) + 360) % 360) - 180 }
}

export function validPosition(p: Position | undefined): p is Position {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180
}

/** Centre and zoom that fit all points into w×h pixels with `pad` pixels to spare. */
export function fit(points: LatLon[], w: number, h: number, pad = 40, maxZoom = 15): { center: LatLon; zoom: number } | null {
  if (!points.length || w <= 0 || h <= 0) return null
  const at0 = points.map((p) => project(p, 0))
  const xs = at0.map((p) => p.x)
  const ys = at0.map((p) => p.y)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const zx = x1 > x0 ? Math.log2((w - 2 * pad) / (x1 - x0)) : maxZoom
  const zy = y1 > y0 ? Math.log2((h - 2 * pad) / (y1 - y0)) : maxZoom
  const zoom = clampZoom(Math.min(zx, zy, maxZoom))
  return { center: unproject({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, 0), zoom }
}

/**
 * Meshtastic truncates coordinates to `bits` of the 32-bit value and reports the middle of
 * the cell, so the true position is within half a cell. Returns that half-cell in metres
 * (north-south), or 0 when exact.
 */
export function precisionRadiusM(bits: number | undefined): number {
  if (!bits || bits >= 32) return 0
  return 2 ** (31 - bits) * 1e-7 * 111_320
}

/** Screen pixels per metre at a latitude and zoom. */
export function pxPerMetre(lat: number, z: number): number {
  const metresPerPx = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z)
  return 1 / metresPerPx
}

/**
 * Markers at (nearly) the same spot, common with coarse positions, are spread on a small
 * ring so each stays visible and clickable. Returns per-input offsets.
 */
export function spread(points: Point[], within = 6, ring = 12): Point[] {
  const out = points.map(() => ({ x: 0, y: 0 }))
  const done = new Set<number>()
  for (let i = 0; i < points.length; i++) {
    if (done.has(i)) continue
    const group = [i]
    for (let j = i + 1; j < points.length; j++)
      if (!done.has(j) && Math.abs(points[j].x - points[i].x) <= within && Math.abs(points[j].y - points[i].y) <= within) group.push(j)
    if (group.length < 2) continue
    const r = ring + 2 * Math.max(0, group.length - 6)
    group.forEach((k, n) => {
      done.add(k)
      const a = (2 * Math.PI * n) / group.length - Math.PI / 2
      out[k] = { x: Math.cos(a) * r, y: Math.sin(a) * r }
    })
  }
  return out
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Greedy label placement: labels are tried in priority order (caller sorts) and kept only
 * where they overlap no kept label or marker. The first `force` labels are always kept.
 * Returns the indices kept.
 */
export function placeLabels(boxes: Box[], obstacles: Box[] = [], force = 0): Set<number> {
  const kept: Box[] = [...obstacles]
  const out = new Set<number>()
  const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  boxes.forEach((b, i) => {
    if (i >= force && kept.some((k) => hit(b, k))) return
    kept.push(b)
    out.add(i)
  })
  return out
}
