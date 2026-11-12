<script lang="ts">
  import { type CoverageSpan, type DaySet, keepRecord, type PacketRecord, type RecordFilter, timeOfDay } from '../../model/analytics'
  import BarChart, { type ChartBucket } from './BarChart.svelte'

  let {
    records,
    coverage,
    filter,
    counts = $bindable(),
  }: {
    records: PacketRecord[]
    coverage: CoverageSpan[]
    filter: RecordFilter
    /** Out: packets per type over the period, for the type filter. */
    counts: Record<string, number>
  } = $props()

  type Mode = 'totals' | 'rate'
  let days = $state<DaySet>('all')
  let mode = $state<Mode>('totals')

  const DAYS: { id: DaySet; label: string }[] = [
    { id: 'all', label: 'All days' },
    { id: 'weekdays', label: 'Weekdays' },
    { id: 'weekends', label: 'Weekends' },
  ]
  const MODES: { id: Mode; label: string; title: string }[] = [
    { id: 'totals', label: 'Totals', title: 'Packets received in each hour of the day, over the whole period' },
    { id: 'rate', label: 'Per connected hour', title: 'Packets divided by the time a radio was connected in that hour; packets held by the radio are left out' },
  ]
  /** Rates from less connected time than this are drawn faded. */
  const MIN_MS = 2 * 3_600_000

  const hours = $derived(timeOfDay(records, coverage, filter, days))

  $effect(() => {
    const c: Record<string, number> = {}
    for (const r of records) if (keepRecord(r, { ...filter, types: null })) c[r.type] = (c[r.type] ?? 0) + 1
    counts = c
  })

  const buckets = $derived(
    hours.map((h): ChartBucket => {
      const per = h.coveredMs / 3_600_000
      const rate = mode === 'rate'
      return {
        start: 0,
        end: 0,
        rx: rate ? (per ? h.rxLive / per : 0) : h.rx,
        tx: rate ? (per ? h.txLive / per : 0) : h.tx,
        coveredMs: h.coveredMs,
        note: `on ${h.days} day${h.days === 1 ? '' : 's'}${rate && h.coveredMs < MIN_MS ? ' · under 2 h of data' : ''}`,
      }
    }),
  )

  const first = $derived.by(() => {
    let t = Infinity
    for (const r of records) if (r.ts < t) t = r.ts
    for (const s of coverage) if (s.start < t) t = s.start
    return t
  })
  const pad = (h: number) => String(h).padStart(2, '0')
  const xLabel = (_: ChartBucket, i: number) => (i % 3 === 0 ? `${pad(i)}:00` : null)
  const title = (b: ChartBucket) => {
    const i = buckets.indexOf(b)
    return `${pad(i)}:00–${pad((i + 1) % 24)}:00`
  }
  const format = (v: number) => (mode === 'totals' || Number.isInteger(v) ? String(Math.round(v)) : v < 10 ? v.toFixed(1) : String(Math.round(v)))
</script>

<div class="bar">
  <span class="seg" role="group" aria-label="Days">
    {#each DAYS as d (d.id)}
      <button class:on={days === d.id} onclick={() => (days = d.id)}>{d.label}</button>
    {/each}
  </span>
  <span class="seg" role="group" aria-label="Values">
    {#each MODES as m (m.id)}
      <button class:on={mode === m.id} title={m.title} onclick={() => (mode = m.id)}>{m.label}</button>
    {/each}
  </span>
  {#if Number.isFinite(first)}
    <span class="muted sum">since {new Date(first).toLocaleDateString([], { day: 'numeric', month: 'numeric' })}</span>
  {/if}
</div>

<BarChart
  {buckets}
  {xLabel}
  {title}
  {format}
  yLabel={mode === 'rate' ? 'packets per connected hour' : 'packets'}
  dim={mode === 'rate' ? (b) => (b.coveredMs ?? 0) > 0 && (b.coveredMs ?? 0) < MIN_MS : undefined}
/>

<details>
  <summary class="faint">Table</summary>
  <table>
    <thead>
      <tr><th>Hour</th><th class="num">Received</th><th class="num">Sent</th><th class="num">Connected</th><th class="num">Days</th></tr>
    </thead>
    <tbody>
      {#each buckets as b, i (i)}
        <tr>
          <td>{title(b)}</td><td class="num">{format(b.rx)}</td><td class="num">{format(b.tx)}</td>
          <td class="num">{(hours[i].coveredMs / 3_600_000).toFixed(1)} h</td><td class="num">{hours[i].days}</td>
        </tr>
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
