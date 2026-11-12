<script lang="ts" module>
  export interface ChartBucket {
    start: number
    end: number
    rx: number
    tx: number
    /** Undefined: coverage does not apply (the bucket is not a span of time). */
    coveredMs?: number
    /** Extra tooltip line. */
    note?: string
  }

</script>

<script lang="ts">
  import { niceScale } from '../../model/analytics'

  let {
    buckets,
    xLabel,
    title,
    rxLabel = 'Received',
    txLabel = 'Sent',
    yLabel = 'packets',
    now = Date.now(),
    format = (v: number) => String(Math.round(v)),
    dim,
    height = 300,
    showRx = true,
    showTx = true,
  }: {
    buckets: ChartBucket[]
    /** Axis label under bucket i, or null. */
    xLabel: (b: ChartBucket, i: number) => string | null
    /** Tooltip heading for a bucket. */
    title: (b: ChartBucket) => string
    rxLabel?: string
    txLabel?: string
    yLabel?: string
    now?: number
    format?: (v: number) => string
    /** Buckets drawn faded, e.g. too little data behind them. */
    dim?: (b: ChartBucket) => boolean
    height?: number
    /** Series in the legend and tooltip; one alone needs no legend swatch. */
    showRx?: boolean
    showTx?: boolean
  } = $props()

  const H = $derived(height)
  const PAD = { l: 44, r: 8, t: 10, b: 22 }
  let width = $state(600)
  const plotW = $derived(Math.max(50, width - PAD.l - PAD.r))
  const plotH = $derived(H - PAD.t - PAD.b)

  const scale = $derived(niceScale(Math.max(0, ...buckets.map((b) => b.rx + b.tx))))
  const ticks = $derived(Array.from({ length: Math.round(scale.top / scale.step) + 1 }, (_, i) => i * scale.step))
  const band = $derived(plotW / Math.max(1, buckets.length))
  const gap = $derived(band >= 6 ? 2 : band >= 3 ? 1 : 0)
  const barW = $derived(Math.max(1, band - gap))
  const y = (v: number) => PAD.t + plotH - (v / scale.top) * plotH

  /** A bar segment from y0 (bottom) to y1 (top); rounded top when it ends the bar. */
  function seg(x: number, y0: number, y1: number, round: boolean): string {
    const h = y0 - y1
    if (h <= 0) return ''
    const r = round ? Math.min(4, barW / 2, h) : 0
    return `M${x},${y0}V${y1 + r}${r ? `a${r},${r} 0 0 1 ${r},${-r}` : ''}H${x + barW - r}${r ? `a${r},${r} 0 0 1 ${r},${r}` : ''}V${y0}Z`
  }

  const bars = $derived(
    buckets.map((b, i) => {
      const x = PAD.l + i * band + gap / 2
      const base = y(0)
      const rxTop = y(b.rx)
      // 2px surface gap between the received and sent segments.
      const txBase = b.rx > 0 && b.tx > 0 ? rxTop - 2 : rxTop
      const txTop = Math.min(txBase, y(b.rx + b.tx))
      return {
        x,
        rx: seg(x, base, rxTop, b.tx === 0),
        tx: b.tx > 0 ? seg(x, txBase, txTop, true) : '',
        uncovered: b.coveredMs === 0 && b.start < now,
        faded: dim?.(b) ?? false,
      }
    }),
  )

  let hover = $state<number | null>(null)
  const hb = $derived(hover === null ? null : buckets[hover])
  const tipLeft = $derived(hover === null ? 0 : Math.min(width - 190, Math.max(0, PAD.l + hover * band + band / 2 - 95)))

  const mins = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`)
</script>

<div class="chart" bind:clientWidth={width}>
  <div class="legend">
    {#if showRx && showTx}
      <span><i class="sw rx"></i>{rxLabel}</span>
      <span><i class="sw tx"></i>{txLabel}</span>
    {/if}
    {#if bars.some((b) => b.uncovered)}<span><i class="sw off"></i>Not connected</span>{/if}
    <span class="ylab">y: {yLabel}</span>
  </div>
  <svg {width} height={H} role="img" aria-label="Bar chart of {yLabel}" onmouseleave={() => (hover = null)}>
    <defs>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" class="hatchline" />
      </pattern>
    </defs>
    {#each bars as b, i (i)}
      {#if b.uncovered}<rect x={PAD.l + i * band} y={PAD.t} width={band} height={plotH} fill="url(#hatch)" />{/if}
    {/each}
    {#each ticks as t (t)}
      <line class="grid" x1={PAD.l} x2={PAD.l + plotW} y1={y(t)} y2={y(t)} />
      <text class="ytick" x={PAD.l - 6} y={y(t) + 3.5}>{format(t)}</text>
    {/each}
    {#if hover !== null}<rect class="hl" x={PAD.l + hover * band} y={PAD.t} width={band} height={plotH} />{/if}
    {#each bars as b, i (i)}
      <g class:faded={b.faded}>
        {#if b.rx}<path class="rx" d={b.rx} />{/if}
        {#if b.tx}<path class="tx" d={b.tx} />{/if}
      </g>
    {/each}
    <line class="axis" x1={PAD.l} x2={PAD.l + plotW} y1={y(0)} y2={y(0)} />
    {#each buckets as bk, i (i)}
      {@const l = xLabel(bk, i)}
      {#if l}<text class="xtick" x={PAD.l + i * band + band / 2} y={H - 6}>{l}</text>{/if}
    {/each}
    {#each buckets as _, i (i)}
      <rect
        class="hit"
        role="presentation"
        x={PAD.l + i * band}
        y={PAD.t}
        width={band}
        height={plotH}
        onmouseenter={() => (hover = i)}
      />
    {/each}
  </svg>
  {#if hb}
    <div class="tip" style:left="{tipLeft}px">
      <div class="th">{title(hb)}</div>
      {#if showRx}<div><i class="sw rx"></i>{rxLabel} <b>{format(hb.rx)}</b></div>{/if}
      {#if showTx}<div><i class="sw tx"></i>{txLabel} <b>{format(hb.tx)}</b></div>{/if}
      {#if hb.coveredMs !== undefined}<div class="faint">Connected {mins(hb.coveredMs)}</div>{/if}
      {#if hb.note}<div class="faint">{hb.note}</div>{/if}
    </div>
  {/if}
</div>

<style>
  .chart {
    position: relative;
  }
  svg {
    display: block;
  }
  .legend {
    display: flex;
    gap: 14px;
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 4px;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .ylab {
    margin-left: auto;
    color: var(--faint);
  }
  .sw {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
  }
  .sw.rx {
    background: var(--rx);
  }
  .sw.tx {
    background: var(--tx);
  }
  .sw.off {
    background: repeating-linear-gradient(45deg, var(--border) 0 2px, transparent 2px 5px);
    outline: 1px solid var(--border);
  }
  .rx {
    fill: var(--rx);
  }
  .tx {
    fill: var(--tx);
  }
  .faded {
    opacity: 0.35;
  }
  .grid {
    stroke: var(--border);
    stroke-width: 1;
    opacity: 0.6;
  }
  .axis {
    stroke: var(--faint);
  }
  .hatchline {
    stroke: var(--border);
    stroke-width: 2;
  }
  .ytick,
  .xtick {
    fill: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .ytick {
    text-anchor: end;
  }
  .xtick {
    text-anchor: middle;
  }
  .hl {
    fill: var(--hover);
  }
  .hit {
    fill: transparent;
  }
  .tip {
    position: absolute;
    top: 26px;
    width: 190px;
    padding: 7px 9px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 12px;
    pointer-events: none;
    display: grid;
    gap: 2px;
  }
  .tip .th {
    font-weight: 600;
    margin-bottom: 2px;
  }
  .tip b {
    float: right;
    font-variant-numeric: tabular-nums;
  }
  .tip .sw {
    margin-right: 5px;
  }
</style>
