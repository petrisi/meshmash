// Per-radio map centre and zoom, so the map opens where it was left.
import type { LatLon } from '../map/geo'

export interface MapViewState {
  center: LatLon
  zoom: number
}

const key = (radio: string) => `meshmash.mapView.${radio}`

export function loadMapView(radio: string): MapViewState | null {
  try {
    const v = JSON.parse(localStorage.getItem(key(radio)) ?? 'null')
    return v && Number.isFinite(v.center?.lat) && Number.isFinite(v.center?.lon) && Number.isFinite(v.zoom) ? v : null
  } catch {
    return null
  }
}

export function saveMapView(radio: string, v: MapViewState) {
  try {
    localStorage.setItem(key(radio), JSON.stringify(v))
  } catch {
    /* storage unavailable */
  }
}
