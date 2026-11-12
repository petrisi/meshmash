<script lang="ts">
  import { clock } from '../../format'
  import { activity, type ActivityRange, bucketEdges, type CoverageSpan, keepRecord, type PacketRecord, type RecordFilter } from '../../model/analytics'
  import BarChart, { type ChartBucket } from './BarChart.svelte'

  let {
    records,
    coverage,
    filter,
    range = $bindable(),
    counts = $bindable(),
  }: {
    records: PacketRecord[]
    coverage: CoverageSpan[]
    filter: RecordFilter
    range: ActivityRange
    /** Out: packets per type in the range, for the type filter. */
    counts: Record<string, number>
  } = $props()

  const RANGES: { id: ActivityRange; label: string }[] = [
    { id: '24h', label: '24 h' },
    { id: '7d', label: '7 days' },
    { id: '30d', label: '30 days' },
  ]

  const now = $derived.by(() => {
    void coverage // refreshed with the data
    return Date.now()
  })
  const buckets = $derived(activity(records, coverage, range, now, filter))

  $effect(() => {
    const edges = bucketEdges(range, now)
    const from = edges[0]
    const to = edges[edges.length - 1]
    const c: Record<string, number> = {}
    for (const r of records) {
      if (r.ts < from || r.ts >= to || !keepRecord(r, { ...filter, types: null })) continue
      c[r.type] = (c[r.type] ?? 0) + 1
    }
    counts = c
  })

  const totals = $derived(buckets.reduce((t, b) => ({ rx: t.rx + b.rx, tx: t.tx + b.tx }), { rx: 0, tx: 0 }))
  const connected = $derived(buckets.reduce((s, b) => s + b.coveredMs, 0))

  const day = (ts: number) => new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'numeric' })
  const shortDate = (ts: number) => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'numeric' })

  function xLabel(b: ChartBucket, i: number): string | null {
    const d = new Date(b.start)
    if (range === '24h') return d.getHours() % 3 === 0 ? clock(b.start) : null
    if (range === '7d') return d.getHours() === 0 ? day(b.start) : null
    return (buckets.length - 1 - i) % 5 === 0 ? shortDate(b.start) : null
  }
  const title = (b: ChartBucket) => (range === '30d' ? day(b.start) : `${day(b.start)} ${clock(b.start)}–${clock(b.end)}`)
  const hours = (ms: number) => (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 60_000)} min`)
</script>

<div class="bar">
  <span class="seg" role="group" aria-label="Period">
    {#each RANGES as r (r.id)}
      <button class:on={range === r.id} onclick={() => (range = r.id)}>{r.label}</button>
    {/each}
  </span>
  <span class="muted sum">
    {totals.rx} received · {totals.tx} sent · connected {hours(connected)}
  </span>
</div>

<BarChart buckets={buckets} {xLabel} {title} {now} />

<details>
  <summary class="faint">Table</summary>
  <table>
    <thead><tr><th>{range === '30d' ? 'Day' : 'Hour'}</th><th class="num">Received</th><th class="num">Sent</th><th class="num">Connected</th></tr></thead>
    <tbody>
      {#each [...buckets].reverse() as b (b.start)}
        <tr><td>{title(b)}</td><td class="num">{b.rx}</td><td class="num">{b.tx}</td><td class="num">{Math.round(b.coveredMs / 60_000)} min</td></tr>
      {/each}
    </tbody>
  </table>
</details>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
  }
  .seg {
    display: inline-flex;
  }
  .seg button {
    padding: 2px 10px;
    font-size: 12px;
    border-radius: 0;
  }
  .seg button + button {
    border-left: none;
  }
  .seg button:first-child {
    border-radius: 4px 0 0 4px;
  }
  .seg button:last-child {
    border-radius: 0 4px 4px 0;
  }
  .seg button.on {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .sum {
    margin-left: auto;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  details {
    margin-top: 10px;
    font-size: 12px;
  }
  summary {
    cursor: pointer;
  }
  table {
    border-collapse: collapse;
    margin-top: 6px;
    font-variant-numeric: tabular-nums;
  }
  th,
  td {
    padding: 2px 12px 2px 0;
    text-align: left;
    white-space: nowrap;
  }
  th {
    color: var(--muted);
    font-weight: 500;
  }
  .num {
    text-align: right;
  }
</style>
