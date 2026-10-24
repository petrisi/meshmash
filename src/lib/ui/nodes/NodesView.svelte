<script lang="ts">
  import { ago, battery, distanceKm, km, snrClass } from '../../format'
  import { KIND_LABEL } from '../../model/capabilities'
  import type { MeshNode, NodeKind } from '../../model/types'
  import { app } from '../../state.svelte'
  import Badge from '../Badge.svelte'
  import NodeDetail from './NodeDetail.svelte'

  type SortKey = 'name' | 'kind' | 'hw' | 'heard' | 'hops' | 'snr' | 'rssi' | 'batt' | 'dist'
  type Col = { key: SortKey; label: string; num?: boolean }

  let query = $state('')
  let filter = $state<string>('all')
  let sortKey = $state<SortKey>('heard')
  let sortAsc = $state(false)

  const proto = $derived(app.protocol!)
  const selfNode = $derived(app.nodeById.get(app.selfId))

  const filters = $derived<{ id: string; label: string; test: (n: MeshNode) => boolean }[]>(
    proto === 'meshcore'
      ? [
          { id: 'all', label: 'All', test: () => true },
          ...(['chat', 'repeater', 'room', 'sensor'] as NodeKind[]).map((k) => ({
            id: k,
            label: KIND_LABEL[k] + 's',
            test: (n: MeshNode) => n.kind === k,
          })),
        ]
      : [
          { id: 'all', label: 'All', test: () => true },
          { id: 'fav', label: 'Favorites', test: (n) => !!n.favorite },
          { id: 'direct', label: 'Direct', test: (n) => n.hops === 0 },
          { id: '2h', label: 'Heard 2h', test: (n) => !!n.lastHeard && Date.now() - n.lastHeard < 7_200_000 },
          { id: 'infra', label: 'Routers', test: (n) => n.kind === 'router' },
        ],
  )

  const cols = $derived<Col[]>([
    { key: 'name', label: 'Name' },
    { key: 'kind', label: proto === 'meshcore' ? 'Type' : 'Role' },
    { key: 'hw', label: 'Hardware' },
    { key: 'heard', label: 'Heard', num: true },
    { key: 'hops', label: 'Hops', num: true },
    { key: 'snr', label: 'SNR', num: true },
    { key: 'rssi', label: 'RSSI', num: true },
    { key: 'batt', label: 'Batt', num: true },
    { key: 'dist', label: 'km', num: true },
  ])

  const dist = (n: MeshNode) => distanceKm(selfNode?.position, n.position)

  function val(n: MeshNode, k: SortKey): string | number | undefined {
    switch (k) {
      case 'name': return n.longName.toLowerCase()
      case 'kind': return n.kind
      case 'hw': return n.hwModel
      case 'heard': return n.lastHeard
      case 'hops': return n.hops
      case 'snr': return n.snr
      case 'rssi': return n.rssi
      case 'batt': return n.batteryPct
      case 'dist': return dist(n)
    }
  }

  const rows = $derived.by(() => {
    const f = filters.find((x) => x.id === filter) ?? filters[0]
    const q = query.trim().toLowerCase()
    const list = app.nodes.filter(
      (n) =>
        n.id !== app.selfId &&
        f.test(n) &&
        (!q || n.longName.toLowerCase().includes(q) || n.shortName.toLowerCase().includes(q) || n.id.includes(q)),
    )
    const dir = sortAsc ? 1 : -1
    list.sort((a, b) => {
      const va = val(a, sortKey)
      const vb = val(b, sortKey)
      // Unknown values always last.
      if (va === undefined) return vb === undefined ? 0 : 1
      if (vb === undefined) return -1
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir
    })
    return list
  })

  // While the pointer is over the table, keep row order stable so live updates don't move
  // rows under the cursor. The snapshot is tied to the current sort/filter.
  let hovering = $state(false)
  let snapshot: { key: string; ids: string[] } | null = null
  const viewKey = $derived(`${sortKey}|${sortAsc}|${filter}|${query}`)
  const shown = $derived.by(() => {
    if (!hovering || !snapshot || snapshot.key !== viewKey) {
      snapshot = { key: viewKey, ids: rows.map((n) => n.id) }
      return rows
    }
    const byId = new Map(rows.map((n) => [n.id, n]))
    return snapshot.ids.flatMap((id) => byId.get(id) ?? [])
  })

  function sortBy(k: SortKey) {
    if (sortKey === k) sortAsc = !sortAsc
    else {
      sortKey = k
      sortAsc = k === 'name' || k === 'kind' || k === 'hw' || k === 'hops' || k === 'dist'
    }
  }

  const selected = $derived(app.selectedNode ? app.nodeById.get(app.selectedNode) : undefined)

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const all = selfNode ? [selfNode, ...shown] : shown
    const i = all.findIndex((n) => n.id === app.selectedNode)
    const next = all[Math.min(all.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next) {
      app.selectedNode = next.id
      document.getElementById(`node-${next.id}`)?.scrollIntoView({ block: 'nearest' })
    }
  }
</script>

<div class="grid">
  <section>
    <div class="toolbar">
      <input placeholder="Filter by name or id" bind:value={query} />
      <div class="chips">
        {#each filters as f (f.id)}
          <button class:on={filter === f.id} onclick={() => (filter = f.id)}>
            {f.label} <span class="faint">{app.nodes.filter((n) => n.id !== app.selfId && f.test(n)).length}</span>
          </button>
        {/each}
      </div>
      <span class="faint total">{hovering ? 'order paused · ' : ''}{rows.length} shown</span>
    </div>

    <div
      class="tablewrap"
      role="grid"
      tabindex="0"
      onkeydown={onKey}
      onmouseenter={() => (hovering = true)}
      onmouseleave={() => (hovering = false)}
    >
      <table>
        <thead>
          <tr>
            <th class="b"></th>
            {#each cols as c (c.key)}
              <th class:num={c.num} class:sorted={sortKey === c.key} onclick={() => sortBy(c.key)}>
                {c.label}{sortKey === c.key ? (sortAsc ? ' ▲' : ' ▼') : ''}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each selfNode ? [selfNode, ...shown] : shown as n (n.id)}
            {@const isSelf = n.id === app.selfId}
            <tr
              id="node-{n.id}"
              class:self={isSelf}
              class:ignored={n.ignored}
              class:sel={app.selectedNode === n.id}
              onclick={() => (app.selectedNode = n.id)}
              ondblclick={() => !isSelf && app.openDm(n.id)}
            >
              <td class="b"><Badge id={n.id} label={n.shortName} size={20} /></td>
              <td class="name">
                {#key n.lastHeard}<span class="ln" class:heard-flash={!isSelf && Date.now() - (n.lastHeard ?? 0) < 1500}>{n.longName}</span>{/key}
                {#if isSelf}<span class="you">YOU</span>{/if}
                {#if n.favorite}<span class="star">★</span>{/if}
                {#if n.ignored}<span class="ign">IGN</span>{/if}
                <span class="mono faint id">{n.id}</span>
              </td>
              <td class="muted">{n.role ?? KIND_LABEL[n.kind]}</td>
              <td class="muted hw">{n.hwModel ?? ''}</td>
              <td class="num">{isSelf ? '' : ago(n.lastHeard, app.now)}</td>
              <td class="num">{isSelf ? '' : (n.hops ?? '—')}</td>
              <td class="num {snrClass(n.snr)}">{n.snr ?? ''}</td>
              <td class="num">{n.rssi ?? ''}</td>
              <td class="num" class:poor={n.batteryPct !== undefined && n.batteryPct < 20}>{battery(n.batteryPct)}</td>
              <td class="num">{isSelf ? '' : km(dist(n))}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <aside>
    {#if selected}
      {#key selected.id}<NodeDetail node={selected} />{/key}
    {:else}
      <p class="faint hint">Select a node. Double-click to open a direct message.</p>
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
  }
  .toolbar input {
    width: 240px;
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
  .tablewrap {
    flex: 1;
    overflow: auto;
    outline: none;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--panel);
    text-align: left;
    font-weight: 500;
    font-size: 11.5px;
    color: var(--muted);
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  th.sorted {
    color: var(--accent);
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
  .b {
    width: 1px;
    padding-right: 0;
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
  .name {
    max-width: 0;
    width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ln {
    font-weight: 500;
  }
  .id {
    margin-left: 6px;
  }
  .you {
    margin-left: 6px;
    font-size: 10px;
    font-weight: 700;
    padding: 0 5px;
    border-radius: 3px;
    background: var(--accent);
    color: var(--accent-ink);
  }
  tr.ignored td {
    opacity: 0.45;
  }
  .ign {
    margin-left: 6px;
    font-size: 10px;
    font-weight: 700;
    color: var(--danger);
  }
  .star {
    margin-left: 4px;
    color: var(--fair);
  }
  .hw {
    font-size: 12px;
  }
  aside {
    overflow-y: auto;
    background: var(--panel);
    border-left: 1px solid var(--border);
  }
  .hint {
    padding: 16px;
  }
</style>
