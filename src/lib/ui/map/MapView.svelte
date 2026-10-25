<script lang="ts">
  import { untrack } from 'svelte'
  import { ago, distanceKm, km, snrClass } from '../../format'
  import { fit, type LatLon, placeLabels, type Point, precisionRadiusM, pxPerMetre, spread, validPosition } from '../../map/geo'
  import { KIND_LABEL } from '../../model/capabilities'
  import { matchesQuery, nodeFilters } from '../../model/filters'
  import type { MeshNode, NodeKind } from '../../model/types'
  import { app } from '../../state.svelte'
  import { loadMapView, saveMapView } from '../../store/mapView'
  import NodeDetail from '../nodes/NodeDetail.svelte'
  import SlippyMap, { type Viewport } from './SlippyMap.svelte'

  const HOUR = 3_600_000
  /**
   * First view: recently heard nearby nodes, widening until a few qualify. Far nodes (heard
   * through MQTT or long flood paths) would otherwise zoom out to half a continent.
   */
  const FIT_STAGES = [
    { ms: 48 * HOUR, km: 150 },
    { ms: 7 * 24 * HOUR, km: 300 },
  ]

  let filter = $state('all')
  let query = $state('')
  let showLabels = $state(true)
  let showLinks = $state(true)

  const filters = $derived(nodeFilters(app.protocol!))
  const self = $derived(app.nodeById.get(app.selfId))
  const located = $derived(app.nodes.filter((n) => validPosition(n.position)))
  const shown = $derived.by(() => {
    const f = filters.find((x) => x.id === filter) ?? filters[0]
    return located.filter((n) => n.id === app.selfId || (f.test(n) && matchesQuery(n, query)))
  })
  const unlocated = $derived(app.nodes.filter((n) => n.id !== app.selfId && !validPosition(n.position)).length)
  const selected = $derived(app.selectedNode ? app.nodeById.get(app.selectedNode) : undefined)

  // Initial view: the node asked for by "Show on map", else as left for this radio, else
  // fitted once the map has a size.
  const radio = app.selfId
  const initial = untrack(() => {
    const f = app.mapFocus ? app.nodeById.get(app.mapFocus.id)?.position : undefined
    if (validPosition(f)) return { center: { lat: f.lat, lon: f.lon }, zoom: Math.max(loadMapView(radio)?.zoom ?? 0, 13) }
    const own = self?.position
    return loadMapView(radio) ?? (validPosition(own) ? { center: { lat: own.lat, lon: own.lon }, zoom: 10, guess: true } : null)
  })
  let center = $state<LatLon>(initial?.center ?? { lat: 30, lon: 0 })
  let zoom = $state(initial?.zoom ?? 3)
  let width = $state(0)
  let height = $state(0)
  let fitted = !!initial && !('guess' in initial)

  function fitTo(nodes: MeshNode[]) {
    const v = fit(
      nodes.map((n) => n.position!),
      width,
      height,
    )
    if (!v) return
    center = v.center
    zoom = v.zoom
  }

  function initialSet(): MeshNode[] {
    for (const s of FIT_STAGES) {
      const near = located.filter(
        (n) =>
          n.id === app.selfId ||
          (n.lastHeard !== undefined &&
            app.now - n.lastHeard < s.ms &&
            (!validPosition(self?.position) || (distanceKm(self.position, n.position) ?? 0) < s.km)),
      )
      if (near.length >= 3) return near
    }
    return located
  }

  $effect(() => {
    if (fitted || !width || !located.length) return
    fitted = true
    untrack(() => fitTo(initialSet()))
  })

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    const v = { center: $state.snapshot(center), zoom }
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => radio && saveMapView(radio, v), 500)
  })

  // "Show on map" while the map is open: centre on that node.
  let focusN = untrack(() => app.mapFocus?.n ?? 0)
  $effect(() => {
    const f = app.mapFocus
    if (!f || f.n === focusN) return
    focusN = f.n
    const p = untrack(() => app.nodeById.get(f.id)?.position)
    if (!validPosition(p)) return
    center = { lat: p.lat, lon: p.lon }
    zoom = Math.max(untrack(() => zoom), 13)
  })

  type Recency = 'self' | 'fresh' | 'recent' | 'stale'
  type Shape = 'circle' | 'diamond' | 'square' | 'triangle'

  function recency(n: MeshNode): Recency {
    if (n.id === app.selfId) return 'self'
    const age = n.lastHeard === undefined ? Infinity : app.now - n.lastHeard
    return age < HOUR ? 'fresh' : age < 24 * HOUR ? 'recent' : 'stale'
  }

  const SHAPE: Partial<Record<NodeKind, Shape>> = { router: 'diamond', repeater: 'diamond', room: 'square', sensor: 'triangle' }

  const LEGEND = $derived<{ shape: Shape; label: string }[]>(
    app.protocol === 'meshcore'
      ? [
          { shape: 'circle', label: 'Companion' },
          { shape: 'diamond', label: 'Repeater' },
          { shape: 'square', label: 'Room server' },
          { shape: 'triangle', label: 'Sensor' },
        ]
      : [
          { shape: 'circle', label: 'Client' },
          { shape: 'diamond', label: 'Router' },
          { shape: 'triangle', label: 'Sensor' },
        ],
  )

  /** A node id as stored in routes and neighbour lists; MeshCore may use a shorter key prefix. */
  function resolve(id: string): MeshNode | undefined {
    return app.nodeById.get(id) ?? (id.length >= 4 ? located.find((n) => n.id.startsWith(id)) : undefined)
  }

  interface Mark {
    n: MeshNode
    base: Point
    at: Point
    rec: Recency
    shape: Shape
    /** Precision radius in px; 0 when exact. */
    r: number
  }
  interface Link {
    points: Point[]
    cls: string
    title: string
  }

  const MARGIN = 60

  function layout(vp: Viewport) {
    const inView = (p: Point) => p.x > -MARGIN && p.y > -MARGIN && p.x < vp.width + MARGIN && p.y < vp.height + MARGIN
    const all = shown.map((n) => ({ n, base: vp.toScreen(n.position!) }))
    const visible = all.filter((m) => inView(m.base))
    const off = spread(visible.map((m) => m.base))
    const marks: Mark[] = visible.map((m, i) => ({
      ...m,
      at: { x: m.base.x + off[i].x, y: m.base.y + off[i].y },
      rec: recency(m.n),
      shape: SHAPE[m.n.kind] ?? 'circle',
      r: precisionRadiusM(m.n.position!.precisionBits) * pxPerMetre(m.n.position!.lat, vp.zoom),
    }))
    const at = new Map(marks.map((m) => [m.n.id, m.at]))
    const screen = (n: MeshNode | undefined) => (n && validPosition(n.position) ? (at.get(n.id) ?? vp.toScreen(n.position)) : undefined)

    const links: Link[] = []
    const me = screen(self)
    if (showLinks && me) {
      for (const n of shown)
        if (n.id !== app.selfId && n.hops === 0 && n.lastHeard !== undefined && app.now - n.lastHeard < 24 * HOUR) {
          const p = screen(n)
          if (p) links.push({ points: [me, p], cls: `direct ${snrClass(n.snr)}`, title: `${n.longName}: direct${n.snr !== undefined ? `, ${n.snr} dB` : ''}` })
        }
    }
    if (showLinks && selected) {
      const tr = app.traceroutes[selected.id] ?? app.traceHistory[selected.id]?.[0]
      for (const [ids, cls] of [[tr?.towards, 'route'], [tr?.back, 'route back']] as const) {
        const pts = (ids ?? []).flatMap((id) => screen(resolve(id)) ?? [])
        if (pts.length > 1) links.push({ points: pts, cls, title: cls === 'route' ? 'Route towards' : 'Route back' })
      }
      const from = screen(selected)
      for (const nb of (from && app.remote[selected.id]?.neighbours?.list) || []) {
        const n = resolve(nb.id)
        const p = screen(n)
        if (p) links.push({ points: [from!, p], cls: `nb ${snrClass(nb.snr)}`, title: `${selected.longName} ↔ ${n!.longName}: ${nb.snr} dB` })
      }
    }

    // Labels: most relevant first, then whatever still fits.
    const rank = (m: Mark) =>
      m.n.id === app.selectedNode ? 0 : m.rec === 'self' ? 1 : m.n.favorite ? 2 : m.n.hops === 0 ? 3 : { fresh: 4, recent: 5, stale: 6, self: 1 }[m.rec]
    const candidates = marks
      .filter((m) => inView(m.at) && (showLabels || m.n.id === app.selectedNode || m.rec === 'self'))
      .sort((a, b) => rank(a) - rank(b))
    const text = (n: MeshNode) => (n.longName.length > 22 ? n.longName.slice(0, 21) + '…' : n.longName)
    const boxes = candidates.map((m) => ({ x: m.at.x + 9, y: m.at.y - 8, w: text(m.n).length * 6.3 + 8, h: 16 }))
    const keep = placeLabels(
      boxes,
      marks.map((m) => ({ x: m.at.x - 6, y: m.at.y - 6, w: 12, h: 12 })),
      candidates.filter((m) => rank(m) <= 1).length,
    )
    const labels = candidates.flatMap((m, i) => (keep.has(i) ? [{ id: m.n.id, x: boxes[i].x, y: m.at.y, text: text(m.n), rec: m.rec }] : []))
    return { marks, links, labels }
  }

  let hover = $state<{ id: string; x: number; y: number } | null>(null)
  const hovered = $derived(hover ? app.nodeById.get(hover.id) : undefined)

  const precisionText = (n: MeshNode) => {
    const r = precisionRadiusM(n.position?.precisionBits)
    return r ? `±${r >= 1000 ? `${(r / 1000).toFixed(1)} km` : `${Math.round(r)} m`}` : ''
  }

  function select(n: MeshNode) {
    app.selectedNode = n.id
  }
</script>

<div class="grid">
  <section>
    <div class="toolbar">
      <input placeholder="Filter by name or id" bind:value={query} />
      <div class="chips">
        {#each filters as f (f.id)}
          <button class:on={filter === f.id} onclick={() => (filter = f.id)}>{f.label}</button>
        {/each}
      </div>
      <label><input type="checkbox" bind:checked={showLabels} /> Labels</label>
      <label><input type="checkbox" bind:checked={showLinks} /> Links</label>
      <button onclick={() => fitTo(shown)} disabled={!shown.length}>Fit</button>
      <span class="faint total">{shown.length} on map{unlocated ? ` · ${unlocated} without position` : ''}</span>
    </div>
    <div class="mapwrap" bind:clientWidth={width} bind:clientHeight={height}>
      <SlippyMap bind:center bind:zoom onbackground={() => (app.selectedNode = null)}>
        {#snippet overlay(vp: Viewport)}
          {@const L = layout(vp)}
          <svg class="overlay" width={vp.width} height={vp.height}>
            {#each L.marks as m (m.n.id)}
              {#if m.r > 4}<circle class="prec" cx={m.base.x} cy={m.base.y} r={m.r} />{/if}
            {/each}
            {#each L.links as l, i (i)}
              <polyline class="link {l.cls}" points={l.points.map((p) => `${p.x},${p.y}`).join(' ')}><title>{l.title}</title></polyline>
            {/each}
            {#each L.marks as m (m.n.id)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <g
                class="mk {m.rec}"
                class:sel={m.n.id === app.selectedNode}
                class:ignored={m.n.ignored}
                transform="translate({m.at.x} {m.at.y})"
                role="button"
                tabindex="-1"
                aria-label={m.n.longName}
                onclick={() => select(m.n)}
                ondblclick={(e) => {
                  e.stopPropagation()
                  if (m.n.id !== app.selfId) app.openDm(m.n.id)
                }}
                onpointerenter={() => (hover = { id: m.n.id, x: m.at.x, y: m.at.y })}
                onpointerleave={() => (hover = null)}
              >
                {#if m.n.id === app.selectedNode}<circle class="ring" r="11" />{/if}
                <circle class="hit" r="10" />
                {#if m.shape === 'diamond'}<rect x="-5" y="-5" width="10" height="10" transform="rotate(45)" />
                {:else if m.shape === 'square'}<rect x="-5" y="-5" width="10" height="10" />
                {:else if m.shape === 'triangle'}<path d="M0 -6.5 L6 4.5 L-6 4.5 Z" />
                {:else}<circle r={m.rec === 'self' ? 6.5 : 5.5} />{/if}
              </g>
            {/each}
            {#each L.labels as lb (lb.id)}
              <text class="label {lb.rec}" class:sel={lb.id === app.selectedNode} x={lb.x} y={lb.y + 4}>{lb.text}</text>
            {/each}
          </svg>
          {#if hover && hovered}
            <div class="tip" style:left="{Math.min(hover.x + 14, vp.width - 230)}px" style:top="{Math.min(hover.y + 12, vp.height - 110)}px">
              <b>{hovered.longName}</b>
              <span class="faint">{hovered.role ?? KIND_LABEL[hovered.kind]}{hovered.hwModel ? ` · ${hovered.hwModel}` : ''}</span>
              {#if hovered.id !== app.selfId}
                <span>
                  heard {ago(hovered.lastHeard, app.now)}{hovered.hops !== undefined ? ` · ${hovered.hops === 0 ? 'direct' : `${hovered.hops} hop${hovered.hops === 1 ? '' : 's'}`}` : ''}{hovered.snr !== undefined ? ` · ${hovered.snr} dB` : ''}
                </span>
                {#if self?.position}<span>{km(distanceKm(self.position, hovered.position))} km {precisionText(hovered)}</span>{/if}
              {:else if precisionText(hovered)}<span>{precisionText(hovered)}</span>{/if}
            </div>
          {/if}
          <div class="legend">
            {#each LEGEND as l (l.label)}
              <span><svg width="12" height="12" viewBox="-6 -6 12 12" class="mk fresh">
                {#if l.shape === 'diamond'}<rect x="-3.5" y="-3.5" width="7" height="7" transform="rotate(45)" />
                {:else if l.shape === 'square'}<rect x="-4" y="-4" width="8" height="8" />
                {:else if l.shape === 'triangle'}<path d="M0 -5 L4.5 3.5 L-4.5 3.5 Z" />
                {:else}<circle r="4" />{/if}
              </svg>{l.label}</span>
            {/each}
            <span class="sep"></span>
            <span><i class="dot fresh"></i>&lt; 1 h</span>
            <span><i class="dot recent"></i>&lt; 24 h</span>
            <span><i class="dot stale"></i>older</span>
          </div>
        {/snippet}
      </SlippyMap>
    </div>
  </section>

  <aside>
    {#if selected}
      {#key selected.id}<NodeDetail node={selected} />{/key}
    {:else}
      <p class="faint hint">Select a node on the map. Double-click to open a direct message.</p>
    {/if}
  </aside>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: 1fr 380px;
    height: 100%;
    min-height: 0;
  }
  section {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    font-size: 12.5px;
  }
  .toolbar input:not([type]) {
    width: 200px;
  }
  .toolbar label {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .chips {
    display: flex;
    gap: 4px;
  }
  .chips button {
    padding: 2px 9px;
    border-radius: 12px;
    font-size: 12px;
  }
  .chips button.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .total {
    margin-left: auto;
    font-size: 12px;
  }
  .mapwrap {
    flex: 1;
    min-height: 0;
  }
  aside {
    border-left: 1px solid var(--border);
    background: var(--panel);
    overflow-y: auto;
  }
  .hint {
    padding: 16px;
  }

  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: visible;
  }
  .prec {
    fill: color-mix(in srgb, var(--accent) 7%, transparent);
    stroke: color-mix(in srgb, var(--accent) 35%, transparent);
    stroke-dasharray: 3 3;
  }
  .link {
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: stroke;
  }
  .link.direct {
    stroke-width: 1.5;
    stroke-dasharray: 4 3;
    opacity: 0.85;
  }
  .link.good {
    stroke: var(--good);
  }
  .link.fair {
    stroke: var(--fair);
  }
  .link.poor {
    stroke: var(--poor);
  }
  .link.route {
    stroke: var(--accent);
    stroke-width: 2.5;
  }
  .link.route.back {
    stroke-width: 1.5;
    stroke-dasharray: 6 4;
  }
  .link.nb {
    stroke-width: 1.5;
    stroke-dasharray: 5 3;
  }
  .mk {
    pointer-events: all;
    cursor: pointer;
    outline: none;
  }
  .mk :is(circle, rect, path):not(.hit, .ring) {
    stroke: var(--bg);
    stroke-width: 1.5;
  }
  .mk.fresh :is(circle, rect, path):not(.hit, .ring) {
    fill: var(--accent);
  }
  .mk.recent :is(circle, rect, path):not(.hit, .ring) {
    fill: color-mix(in srgb, var(--accent) 55%, var(--muted));
  }
  .mk.stale :is(circle, rect, path):not(.hit, .ring) {
    fill: var(--faint);
  }
  .mk.self :is(circle, rect, path):not(.hit, .ring) {
    fill: var(--text);
    stroke: var(--accent);
    stroke-width: 2;
  }
  .mk.ignored {
    opacity: 0.4;
  }
  .mk .hit {
    fill: transparent;
  }
  .mk .ring {
    fill: none;
    stroke: var(--text);
    stroke-width: 2;
  }
  .label {
    font-size: 11px;
    font-weight: 600;
    fill: var(--text);
    paint-order: stroke;
    stroke: var(--bg);
    stroke-width: 3px;
    stroke-linejoin: round;
  }
  .label.stale {
    fill: var(--muted);
    font-weight: 500;
  }
  .label.sel {
    fill: var(--accent);
  }
  .tip {
    position: absolute;
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-width: 220px;
    padding: 6px 8px;
    font-size: 11.5px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }
  .legend {
    position: absolute;
    left: 10px;
    bottom: 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    align-items: center;
    max-width: 60%;
    padding: 4px 8px;
    font-size: 11px;
    color: var(--muted);
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .legend span {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .legend .mk {
    cursor: default;
  }
  .legend .sep {
    width: 1px;
    height: 12px;
    background: var(--border);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .dot.fresh {
    background: var(--accent);
  }
  .dot.recent {
    background: color-mix(in srgb, var(--accent) 55%, var(--muted));
  }
  .dot.stale {
    background: var(--faint);
  }
</style>
