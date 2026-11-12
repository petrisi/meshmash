<script lang="ts">
  import { ago, initials } from '../../format'
  import {
    activity,
    BY_NODE_DAYS,
    byNode,
    type CoverageSpan,
    keepRecord,
    type NodeTotals,
    PACKET_TYPES,
    type PacketRecord,
    type RecordFilter,
  } from '../../model/analytics'
  import { app } from '../../state.svelte'
  import Badge from '../Badge.svelte'
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

  const now = $derived.by(() => {
    void coverage // refreshed with the data
    return Date.now()
  })
  const since = $derived(now - BY_NODE_DAYS * 86_400_000)
  const data = $derived(byNode(records, filter, since, app.selfId))

  $effect(() => {
    const c: Record<string, number> = {}
    for (const r of records) if (r.ts >= since && keepRecord(r, { ...filter, types: null })) c[r.type] = (c[r.type] ?? 0) + 1
    counts = c
  })

  let selected = $state<string | null>(null)
  const isSelf = $derived(selected === app.selfId)
  const sel = $derived<NodeTotals | null>(isSelf ? data.sent : (data.nodes.find((n) => n.id === selected) ?? null))

  const nameOf = (n: NodeTotals) => (n.nameOnly ? n.names[0] : (app.nodeById.get(n.id)?.longName ?? n.names[0] ?? n.id))
  const shortOf = (n: NodeTotals) =>
    n.nameOnly ? initials(n.names[0]) : (app.nodeById.get(n.id)?.shortName ?? n.id.replace(/^!/, '').slice(-4))
  const otherNames = (n: NodeTotals) => (n.nameOnly ? [] : n.names.filter((x) => x !== nameOf(n)))
  /** Shown in place of the node id. */
  const idOf = (n: NodeTotals) => (n.nameOnly ? 'name only' : n.id)
  const NAME_ONLY = 'Channel sender known only by the name in its messages; not verified'
  const share = (c: number) => (data.received ? `${((c / data.received) * 100).toFixed(c / data.received < 0.1 ? 1 : 0)}%` : '')

  const typeLabel = $derived(Object.fromEntries(PACKET_TYPES[app.protocol!].map((t) => [t.id, t.label])))
  const breakdown = $derived(
    sel ? Object.entries(sel.byType).sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, label: typeLabel[id] ?? id, n })) : [],
  )
  const maxType = $derived(Math.max(1, ...breakdown.map((b) => b.n)))

  const daily = $derived.by(() => {
    if (!sel) return []
    const s = sel
    const own = (r: PacketRecord) =>
      isSelf
        ? r.dir === 'tx'
        : r.dir === 'rx' && (s.nameOnly ? !r.from && r.type === 'channel' && r.name === s.names[0] : r.from === s.id)
    return activity(records.filter(own), coverage, '30d', now, filter)
  })
  const shortDate = (ts: number) => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'numeric' })
  const dayTitle = (b: ChartBucket) => new Date(b.start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'numeric' })
  const dayLabel = (b: ChartBucket, i: number) => ((daily.length - 1 - i) % 10 === 0 ? shortDate(b.start) : null)
</script>

<div class="grid">
  <section>
    <div class="summary muted">
      {data.received} received from {data.nodes.length} node{data.nodes.length === 1 ? '' : 's'} in {BY_NODE_DAYS} days
      {#if data.unknown}· {data.unknown} without a known sender{/if}
    </div>
    <table>
      <thead>
        <tr>
          <th class="b"></th><th>Node</th><th class="num">Packets</th><th class="num">Share</th><th class="num">Last</th>
        </tr>
      </thead>
      <tbody>
        {#if data.sent}
          <tr class="self" class:sel={isSelf} onclick={() => (selected = app.selfId)}>
            <td class="b"><Badge id={app.selfId} label={app.nodeById.get(app.selfId)?.shortName ?? ''} size={20} /></td>
            <td class="name"><span class="ln">This radio</span> <span class="faint">sent</span></td>
            <td class="num">{data.sent.count}</td>
            <td class="num"></td>
            <td class="num">{ago(data.sent.last, app.now)}</td>
          </tr>
        {/if}
        {#each data.nodes as n (n.id)}
          {@const others = otherNames(n)}
          <tr class:sel={selected === n.id} onclick={() => (selected = n.id)}>
            <td class="b"><Badge id={n.id} label={shortOf(n)} size={20} /></td>
            <td class="name">
              <span class="ln">{nameOf(n)}</span>
              <span class="mono faint" title={n.nameOnly ? NAME_ONLY : undefined}>{idOf(n)}</span>
              {#if others.length}<span class="faint aka" title={others.join(', ')}>also {others.join(', ')}</span>{/if}
            </td>
            <td class="num">{n.count}</td>
            <td class="num muted">{share(n.count)}</td>
            <td class="num muted">{ago(n.last, app.now)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if !data.nodes.length && !data.sent}<p class="faint">No packets with a known sender in this period.</p>{/if}
  </section>

  <aside>
    {#if sel}
      <div class="head">
        <Badge id={sel.id} label={isSelf ? (app.nodeById.get(app.selfId)?.shortName ?? '') : shortOf(sel)} size={36} />
        <div class="titles">
          <div class="ttl">{isSelf ? 'This radio' : nameOf(sel)}</div>
          <div class="mono muted" title={sel.nameOnly ? NAME_ONLY : undefined}>{idOf(sel)}</div>
        </div>
      </div>
      {#if !isSelf && otherNames(sel).length}<p class="muted aka2">Also seen as {otherNames(sel).join(', ')}</p>{/if}
      <p class="muted">
        {sel.count} packets {isSelf ? 'sent' : 'received'} in {BY_NODE_DAYS} days{isSelf ? '' : ` · ${share(sel.count)} of received`}
      </p>
      {#if !isSelf && app.nodeById.has(sel.id)}
        <button class="ghost link" onclick={() => app.showNode(sel.id)}>Open in Nodes →</button>
      {/if}

      <div class="section">By type</div>
      <ul class="hbars" style:--c={isSelf ? 'var(--tx)' : 'var(--rx)'}>
        {#each breakdown as b (b.id)}
          <li>
            <span class="lbl">{b.label}</span>
            <span class="track"><span class="fill" style:width="{(b.n / maxType) * 100}%"></span></span>
            <span class="n">{b.n}</span>
          </li>
        {/each}
      </ul>

      <div class="section">Per day</div>
      <BarChart
        buckets={daily}
        xLabel={dayLabel}
        title={dayTitle}
        {now}
        height={150}
        showRx={!isSelf}
        showTx={isSelf}
      />
    {:else}
      <p class="faint hint">Select a node to see its packets by type and per day.</p>
    {/if}
  </aside>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: 1fr 340px;
    gap: 16px;
    align-items: start;
  }
  section {
    min-width: 0;
  }
  .summary {
    font-size: 12px;
    margin-bottom: 6px;
  }
  table {
    width: 100%;
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
  tbody tr {
    cursor: default;
  }
  tbody tr:hover {
    background: var(--panel);
  }
  tr.sel,
  tr.sel:hover {
    background: var(--accent-soft);
  }
  tr.self td {
    background: var(--own);
    border-bottom: 1px solid var(--border);
  }
  .b {
    width: 1px;
    padding-right: 0;
  }
  .name {
    max-width: 0;
    width: 70%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ln {
    font-weight: 500;
  }
  .name .mono,
  .aka {
    margin-left: 6px;
    font-size: 12px;
  }
  .num {
    text-align: right;
  }
  aside {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    position: sticky;
    top: 0;
  }
  .head {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .titles {
    min-width: 0;
  }
  .ttl {
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  aside p {
    margin: 8px 0 0;
    font-size: 12.5px;
  }
  .link {
    margin-top: 6px;
    padding: 0;
    font-size: 12.5px;
  }
  .section {
    margin: 14px 0 6px;
    font-size: 11.5px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .hbars {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
    font-size: 12px;
  }
  .hbars li {
    display: grid;
    grid-template-columns: 90px 1fr 44px;
    align-items: center;
    gap: 8px;
  }
  .lbl {
    color: var(--muted);
  }
  .track {
    height: 10px;
  }
  .fill {
    display: block;
    height: 100%;
    min-width: 2px;
    background: var(--c);
    border-radius: 0 3px 3px 0;
  }
  .n {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .hint {
    margin: 0;
  }
  @media (max-width: 1100px) {
    .grid {
      grid-template-columns: 1fr;
    }
    aside {
      position: static;
    }
  }
</style>
