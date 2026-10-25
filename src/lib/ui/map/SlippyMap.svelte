<script module lang="ts">
  import type { LatLon, Point } from '../../map/geo'

  /** What overlays need to draw in screen pixels. */
  export interface Viewport {
    zoom: number
    width: number
    height: number
    toScreen(p: LatLon): Point
  }
</script>

<script lang="ts">
  // Pannable, zoomable OpenStreetMap tile map; no map library. Overlays come from the caller.
  import type { Snippet } from 'svelte'
  import { clampZoom, MAX_ZOOM, project, TILE, unproject } from '../../map/geo'

  let {
    center = $bindable(),
    zoom = $bindable(),
    overlay,
    onbackground,
  }: {
    center: LatLon
    zoom: number
    overlay?: Snippet<[Viewport]>
    /** Click on the map itself (not a drag, not an overlay element). */
    onbackground?: () => void
  } = $props()

  let width = $state(0)
  let height = $state(0)
  let el: HTMLDivElement

  const origin = $derived.by(() => {
    const c = project(center, zoom)
    return { x: c.x - width / 2, y: c.y - height / 2 }
  })

  const viewport = $derived<Viewport>({
    zoom,
    width,
    height,
    toScreen: (p) => {
      const w = project(p, zoom)
      return { x: w.x - origin.x, y: w.y - origin.y }
    },
  })

  /** Tiles at zoom tz scaled to the current fractional zoom. */
  function tiles(tz: number) {
    if (tz < 0 || !width || !height) return []
    const n = 2 ** tz
    const size = TILE * 2 ** (zoom - tz)
    const out = []
    for (let ty = Math.floor(origin.y / size); ty <= Math.floor((origin.y + height) / size); ty++) {
      if (ty < 0 || ty >= n) continue
      for (let tx = Math.floor(origin.x / size); tx <= Math.floor((origin.x + width) / size); tx++)
        out.push({
          key: `${tz}/${tx}/${ty}`,
          src: `https://tile.openstreetmap.org/${tz}/${((tx % n) + n) % n}/${ty}.png`,
          x: tx * size - origin.x,
          y: ty * size - origin.y,
          size,
        })
    }
    return out
  }
  const tz = $derived(Math.min(MAX_ZOOM, Math.round(zoom)))
  // The level below stays underneath while new tiles load.
  const layers = $derived([tiles(tz - 1), tiles(tz)])

  /** Zooms keeping the geographic point under screen point `at` in place. */
  function zoomAt(z: number, at: Point = { x: width / 2, y: height / 2 }) {
    z = clampZoom(z)
    const under = unproject({ x: origin.x + at.x, y: origin.y + at.y }, zoom)
    const p = project(under, z)
    center = unproject({ x: p.x - at.x + width / 2, y: p.y - at.y + height / 2 }, z)
    zoom = z
  }

  function panBy(dx: number, dy: number) {
    const c = project(center, zoom)
    center = unproject({ x: c.x + dx, y: c.y + dy }, zoom)
  }

  const local = (e: MouseEvent) => {
    const r = el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  let drag: { id: number; x: number; y: number; moved: boolean } | null = null
  let suppressClick = false

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }
  }
  function onPointerMove(e: PointerEvent) {
    if (!drag || drag.id !== e.pointerId) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < 4) return
    if (!drag.moved) el.setPointerCapture(e.pointerId)
    drag.moved = true
    drag.x = e.clientX
    drag.y = e.clientY
    panBy(-dx, -dy)
  }
  function onPointerUp(e: PointerEvent) {
    if (!drag || drag.id !== e.pointerId) return
    suppressClick = drag.moved
    drag = null
  }
  // A drag must not count as a click on a marker or on the map.
  function onClickCapture(e: MouseEvent) {
    if (!suppressClick) return
    suppressClick = false
    e.stopPropagation()
  }
  function onClick(e: MouseEvent) {
    if (e.target === el || (e.target as Element).closest?.('.tiles')) onbackground?.()
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault()
    // Mouse wheels step about 100 px per notch, trackpads a few px per event.
    const step = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
    zoomAt(zoom - step / 300, local(e))
  }
  // Not via onwheel: it must be non-passive to stop the page from scrolling.
  $effect(() => {
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })
  function onDblClick(e: MouseEvent) {
    if (e.target !== el && !(e.target as Element).closest?.('.tiles')) return
    zoomAt(zoom + 1, local(e))
  }
  function onKey(e: KeyboardEvent) {
    const pan = 120
    const k: Record<string, () => void> = {
      '+': () => zoomAt(zoom + 1),
      '=': () => zoomAt(zoom + 1),
      '-': () => zoomAt(zoom - 1),
      ArrowLeft: () => panBy(-pan, 0),
      ArrowRight: () => panBy(pan, 0),
      ArrowUp: () => panBy(0, -pan),
      ArrowDown: () => panBy(0, pan),
    }
    if (!k[e.key]) return
    e.preventDefault()
    k[e.key]()
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="map"
  bind:this={el}
  bind:clientWidth={width}
  bind:clientHeight={height}
  role="application"
  aria-label="Map. Drag to pan, scroll or +/- to zoom, arrow keys to move."
  tabindex="0"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  onclickcapture={onClickCapture}
  onclick={onClick}
  ondblclick={onDblClick}
  onkeydown={onKey}
>
  {#each layers as layer, i (i)}
    <div class="tiles">
      {#each layer as t (t.key)}
        <img src={t.src} alt="" draggable="false" style:left="{t.x}px" style:top="{t.y}px" style:width="{t.size}px" style:height="{t.size}px" />
      {/each}
    </div>
  {/each}
  {#if overlay && width}{@render overlay(viewport)}{/if}
  <div class="zoom">
    <button title="Zoom in" onclick={() => zoomAt(zoom + 1)}>+</button>
    <button title="Zoom out" onclick={() => zoomAt(zoom - 1)}>−</button>
  </div>
  <span class="attr">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors</span>
</div>

<style>
  .map {
    position: relative;
    overflow: hidden;
    height: 100%;
    background: var(--panel-2);
    cursor: grab;
    touch-action: none;
    user-select: none;
    outline: none;
  }
  .map:active {
    cursor: grabbing;
  }
  .tiles {
    position: absolute;
    inset: 0;
  }
  img {
    position: absolute;
    max-width: none;
    /* Dark rendering of the standard light tiles. */
    filter: invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9) saturate(0.6);
  }
  .zoom {
    position: absolute;
    top: 10px;
    left: 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .zoom button {
    width: 28px;
    height: 28px;
    padding: 0;
    font-size: 16px;
    line-height: 1;
  }
  .attr {
    position: absolute;
    right: 0;
    bottom: 0;
    font-size: 10px;
    color: var(--muted);
    background: color-mix(in srgb, var(--bg) 75%, transparent);
    padding: 1px 5px;
  }
  .attr a {
    color: inherit;
  }
</style>
