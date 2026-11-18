<script lang="ts">
  import { ago } from '../../format'
  import { BY_NODE_DAYS, byScope, type CoverageSpan, keepRecord, type PacketRecord, type RecordFilter, type ScopeTotals } from '../../model/analytics'
  import { app } from '../../state.svelte'

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

  const now = $derived.by(() => {
    void coverage // refreshed with the data
    return Date.now()
  })
  const since = $derived(now - BY_NODE_DAYS * 86_400_000)
  const data = $derived(byScope(records, filter, since))
  const recorded = $derived(data.received - data.unrecorded)

  $effect(() => {
    const c: Record<string, number> = {}
    for (const r of records) if (r.dir === 'rx' && r.ts >= since && keepRecord(r, { ...filter, types: null })) c[r.type] = (c[r.type] ?? 0) + 1
    counts = c
  })

  const OTHER = "Scoped to a region whose name meshmash does not know; it matches the radio's default scope and the scopes chosen for channels"
  const label = (t: ScopeTotals) => (t.scope === null ? 'Unscoped' : t.scope === '' ? 'Other region' : t.scope)
  const share = (c: number) => (recorded ? `${((c / recorded) * 100).toFixed(c / recorded < 0.1 ? 1 : 0)}%` : '')
</script>

<div class="summary muted">
  {recorded} received with the flood scope recorded in {BY_NODE_DAYS} days
  {#if data.unrecorded}· {data.unrecorded} from before scopes were recorded{/if}
</div>
{#if data.rows.length}
  <table>
    <thead>
      <tr><th>Scope</th><th class="num">Packets</th><th class="num">Share</th><th class="num">Last</th></tr>
    </thead>
    <tbody>
      {#each data.rows as t (t.scope)}
        <tr>
          <td class:mono={!!t.scope} class:muted={t.scope === null} title={t.scope === '' ? OTHER : undefined}>{label(t)}</td>
          <td class="num">{t.count}</td>
          <td class="num muted">{share(t.count)}</td>
          <td class="num muted">{ago(t.last, app.now)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{:else}
  <p class="faint">No packets with the flood scope recorded in this period.</p>
{/if}
<p class="faint note">
  A scoped packet shows its region only if the name is known to meshmash: the radio's default scope or one chosen for a channel.
</p>

<style>
  .summary {
    font-size: 12px;
    margin-bottom: 6px;
  }
  table {
    width: 100%;
    max-width: 560px;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  th {
    text-align: left;
    font-weight: 500;
    font-size: 11.5px;
    color: var(--muted);
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 2px 8px;
    height: 26px;
    white-space: nowrap;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  }
  .num {
    text-align: right;
  }
  .note {
    font-size: 12px;
    margin-top: 10px;
  }
</style>
