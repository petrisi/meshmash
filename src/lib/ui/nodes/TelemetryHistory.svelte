<script lang="ts">
  import { clock } from '../../format'
  import { app } from '../../state.svelte'

  let { nodeId }: { nodeId: string } = $props()

  const LABEL: Record<string, [string, string]> = {
    batteryPct: ['Battery', '%'],
    voltage: ['Voltage', 'V'],
    channelUtil: ['Channel util', '%'],
    airUtilTx: ['Air util TX', '%'],
    snr: ['SNR', 'dB'],
    rssi: ['RSSI', 'dBm'],
  }
  const UNIT_BY_PREFIX: [string, string][] = [
    ['Temperature', '°C'],
    ['Voltage', 'V'],
    ['Humidity', '%'],
    ['Pressure', 'hPa'],
    ['Current', 'A'],
  ]
  function describe(key: string): [string, string] {
    return LABEL[key] ?? [key, UNIT_BY_PREFIX.find(([p]) => key.startsWith(p))?.[1] ?? '']
  }

  const W = 300
  const H = 64
  const PAD = { l: 34, r: 6, t: 6, b: 14 }

  interface Series {
    key: string
    label: string
    unit: string
    pts: { ts: number; v: number }[]
    min: number
    max: number
  }

  const series = $derived.by((): Series[] => {
    const samples = app.samples[nodeId] ?? []
    const by = new Map<string, { ts: number; v: number }[]>()
    for (const s of samples)
      for (const [k, v] of Object.entries(s.v)) {
        // Meshtastic reports 101% for external power: not a battery level.
        if (k === 'batteryPct' && v > 100) continue
        by.set(k, [...(by.get(k) ?? []), { ts: s.ts, v }])
      }
    return [...by]
      .filter(([, pts]) => pts.length >= 2)
      .map(([key, pts]) => {
        const [label, unit] = describe(key)
        const vs = pts.map((p) => p.v)
        return { key, label, unit, pts, min: Math.min(...vs), max: Math.max(...vs) }
      })
  })

  function scale(s: Series) {
    const t0 = s.pts[0].ts
    const t1 = s.pts.at(-1)!.ts
    const span = s.max - s.min || Math.abs(s.max) || 1
    const lo = s.min - span * 0.1
    const hi = s.max + span * 0.1
    return {
      x: (ts: number) => PAD.l + ((ts - t0) / (t1 - t0 || 1)) * (W - PAD.l - PAD.r),
      y: (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b),
      t0,
      t1,
    }
  }
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2))
  const when = (ts: number) =>
    Date.now() - ts > 86_400_000 ? new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' }) : clock(ts)

  let hover = $state<{ key: string; i: number } | null>(null)
  let table = $state(false)

  function onMove(e: PointerEvent, s: Series) {
    const svg = e.currentTarget as SVGSVGElement
    const r = svg.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    const sc = scale(s)
    let best = 0
    for (let i = 1; i < s.pts.length; i++)
      if (Math.abs(sc.x(s.pts[i].ts) - px) < Math.abs(sc.x(s.pts[best].ts) - px)) best = i
    hover = { key: s.key, i: best }
  }
</script>

{#if series.length}
  <div class="section">
    <span>History</span>
    <button class="ghost toggle" onclick={() => (table = !table)}>{table ? 'charts' : 'table'}</button>
  </div>
  {#each series as s (s.key)}
    {@const sc = scale(s)}
    {@const last = s.pts.at(-1)!}
    {@const h = hover?.key === s.key ? s.pts[hover.i] : undefined}
    <div class="metric">
      <div class="head">
        <span class="muted">{s.label}</span>
        <span class="val">{fmt(h?.v ?? last.v)} {s.unit}</span>
        <span class="faint when">{h ? when(h.ts) : 'latest'}</span>
      </div>
      {#if table}
        <table>
          <tbody>
            {#each s.pts.slice(-12).reverse() as p (p.ts)}<tr><td class="faint">{when(p.ts)}</td><td>{fmt(p.v)} {s.unit}</td></tr>{/each}
          </tbody>
        </table>
      {:else}
        <svg
          viewBox="0 0 {W} {H}"
          role="img"
          aria-label="{s.label} from {when(sc.t0)} to {when(sc.t1)}, {fmt(s.min)} to {fmt(s.max)} {s.unit}"
          onpointermove={(e) => onMove(e, s)}
          onpointerleave={() => (hover = null)}
        >
          {#each s.max === s.min ? [s.max] : [s.max, s.min] as v, i (i)}
            <line class="grid" x1={PAD.l} x2={W - PAD.r} y1={sc.y(v)} y2={sc.y(v)} />
            <text class="tick" x={PAD.l - 4} y={sc.y(v) + 3} text-anchor="end">{fmt(v)}</text>
          {/each}
          <text class="tick" x={PAD.l} y={H - 2}>{when(sc.t0)}</text>
          <text class="tick" x={W - PAD.r} y={H - 2} text-anchor="end">{when(sc.t1)}</text>
          <polyline class="line" points={s.pts.map((p) => `${sc.x(p.ts)},${sc.y(p.v)}`).join(' ')} />
          {#if h}
            <line class="cross" x1={sc.x(h.ts)} x2={sc.x(h.ts)} y1={PAD.t} y2={H - PAD.b} />
            <circle class="dot" cx={sc.x(h.ts)} cy={sc.y(h.v)} r="4" />
          {/if}
        </svg>
      {/if}
    </div>
  {/each}
{/if}

<style>
  .toggle {
    padding: 0 4px;
    border: none;
    font-size: 11px;
  }
  .metric {
    padding: 0 12px 6px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12px;
  }
  .val {
    font-variant-numeric: tabular-nums;
  }
  .when {
    margin-left: auto;
    font-size: 11px;
  }
  svg {
    display: block;
    width: 100%;
    height: auto;
    touch-action: none;
  }
  .grid {
    stroke: var(--border);
    stroke-width: 1;
  }
  .tick {
    fill: var(--faint);
    font-size: 9px;
  }
  .line {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
  }
  .cross {
    stroke: var(--faint);
    stroke-width: 1;
  }
  .dot {
    fill: var(--accent);
    stroke: var(--panel);
    stroke-width: 2;
  }
  table {
    width: 100%;
    font-size: 11.5px;
    border-collapse: collapse;
  }
  td {
    padding: 0 4px 0 0;
  }
</style>
