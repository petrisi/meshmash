<script lang="ts">
  // Static map composed from OpenStreetMap tiles; no map library.
  import type { Position } from '../model/types'

  export interface MapPoint {
    pos: Position
    label: string
    self?: boolean
  }

  let { points, height = 180 }: { points: MapPoint[]; height?: number } = $props()

  const TILE = 256
  const MAX_ZOOM = 15
  const PAD = 28

  let width = $state(0)

  function project(p: Position, z: number) {
    const world = TILE * 2 ** z
    const lat = (Math.max(-85, Math.min(85, p.lat)) * Math.PI) / 180
    return {
      x: ((p.lon + 180) / 360) * world,
      y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * world,
    }
  }

  // Highest zoom at which all points fit inside the padded box.
  const view = $derived.by(() => {
    if (!width || !points.length) return null
    let z = MAX_ZOOM
    for (; z > 1; z--) {
      const px = points.map((p) => project(p.pos, z))
      const w = Math.max(...px.map((p) => p.x)) - Math.min(...px.map((p) => p.x))
      const h = Math.max(...px.map((p) => p.y)) - Math.min(...px.map((p) => p.y))
      if (w <= width - 2 * PAD && h <= height - 2 * PAD) break
    }
    const px = points.map((p) => project(p.pos, z))
    const cx = (Math.max(...px.map((p) => p.x)) + Math.min(...px.map((p) => p.x))) / 2
    const cy = (Math.max(...px.map((p) => p.y)) + Math.min(...px.map((p) => p.y))) / 2
    const left = cx - width / 2
    const top = cy - height / 2
    const n = 2 ** z
    const tiles = []
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height) / TILE); ty++)
      for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width) / TILE); tx++)
        if (ty >= 0 && ty < n)
          tiles.push({
            key: `${z}/${tx}/${ty}`,
            src: `https://tile.openstreetmap.org/${z}/${((tx % n) + n) % n}/${ty}.png`,
            x: tx * TILE - left,
            y: ty * TILE - top,
          })
    const marks = points.map((p, i) => ({ ...p, x: px[i].x - left, y: px[i].y - top }))
    return { tiles, marks }
  })
</script>

<div class="map" style:height="{height}px" bind:clientWidth={width}>
  {#if view}
    {#each view.tiles as t (t.key)}
      <img src={t.src} alt="" style:left="{t.x}px" style:top="{t.y}px" draggable="false" />
    {/each}
    <svg>
      {#if view.marks.length === 2}
        <line x1={view.marks[0].x} y1={view.marks[0].y} x2={view.marks[1].x} y2={view.marks[1].y} />
      {/if}
    </svg>
    {#each view.marks as m (m.label)}
      <span class="pin" class:self={m.self} style:left="{m.x}px" style:top="{m.y}px">
        <i></i><b>{m.label}</b>
      </span>
    {/each}
  {/if}
  <span class="attr">© OpenStreetMap contributors</span>
</div>

<style>
  .map {
    position: relative;
    overflow: hidden;
    margin: 0 12px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel-2);
  }
  img {
    position: absolute;
    width: 256px;
    height: 256px;
    user-select: none;
    /* Dark rendering of the standard light tiles. */
    filter: invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9) saturate(0.6);
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  line {
    stroke: var(--accent);
    stroke-width: 1.5;
    stroke-dasharray: 4 3;
  }
  .pin {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 4px;
    transform: translate(-5px, -5px);
    white-space: nowrap;
  }
  .pin i {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
    border: 2px solid var(--bg);
  }
  .pin.self i {
    background: var(--text);
  }
  .pin b {
    font-size: 10.5px;
    font-weight: 600;
    padding: 0 4px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--bg) 80%, transparent);
  }
  .attr {
    position: absolute;
    right: 3px;
    bottom: 1px;
    font-size: 9px;
    color: var(--muted);
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    padding: 0 3px;
  }
</style>
