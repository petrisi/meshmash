<script lang="ts">
  import { ago, snrClass } from '../../format'
  import type { TracerouteResult } from '../../model/types'
  import { app } from '../../state.svelte'

  let { nodeId }: { nodeId: string } = $props()

  const history = $derived(app.traceHistory[nodeId] ?? [])
  let picked = $state(0)
  $effect(() => {
    void nodeId
    picked = 0
  })
  $effect(() => {
    // A new result arrives at the top of the list.
    void history.length
    picked = 0
  })
  const tr = $derived<TracerouteResult | undefined>(history[picked] ?? app.traceroutes[nodeId])

  /** Hops the firmware could not identify arrive as the broadcast address. */
  const name = (id: string) =>
    id === '!ffffffff' ? 'unknown relay' : id === app.selfId ? 'You' : (app.nodeById.get(id)?.longName ?? id)
  const db = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? '?' : `${v} dB`)
  const weakest = (t: TracerouteResult) => {
    const all = [...t.snrTowards, ...(t.snrBack ?? [])].filter((v) => !Number.isNaN(v))
    return all.length ? Math.min(...all) : undefined
  }
  const secs = (ms?: number) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`)
</script>

{#if tr}
  <div class="section">
    <span>Route</span>
    <span class="faint">
      {tr.towards.length - 1} out{tr.back ? ` · ${tr.back.length - 1} back` : ''}{tr.rttMs !== undefined
        ? ` · ${secs(tr.rttMs)}`
        : ''} · {ago(tr.ts, app.now)} ago
    </span>
  </div>
  <div class="route">
    {#each [{ label: 'Towards', ids: tr.towards, snr: tr.snrTowards }, ...(tr.back ? [{ label: 'Back', ids: tr.back, snr: tr.snrBack ?? [] }] : [])] as leg (leg.label)}
      <div class="dir muted">{leg.label}</div>
      <ol>
        {#each leg.ids as id, i (i)}
          <li>
            <button class="hop" onclick={() => app.nodeById.has(id) && app.showNode(id)}>{name(id)}</button>
            {#if i > 0}<span class="mono {snrClass(leg.snr[i - 1])}">{db(leg.snr[i - 1])}</span>{/if}
          </li>
        {/each}
      </ol>
    {/each}
    {#if !tr.back}<div class="faint small">No return route reported.</div>{/if}
  </div>

  {#if history.length > 1}
    <table class="hist">
      <thead><tr><th>When</th><th>Out</th><th>Back</th><th>Weakest</th><th>Time</th></tr></thead>
      <tbody>
        {#each history as h, i (h.ts)}
          <tr class:sel={i === picked} onclick={() => (picked = i)}>
            <td>{ago(h.ts, app.now)}</td>
            <td>{h.towards.length - 1}</td>
            <td>{h.back ? h.back.length - 1 : '—'}</td>
            <td class={snrClass(weakest(h))}>{db(weakest(h))}</td>
            <td>{secs(h.rttMs)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
{/if}

<style>
  .route {
    padding: 0 12px 6px;
  }
  .dir {
    font-size: 11px;
    margin-top: 2px;
  }
  ol {
    margin: 2px 0 6px;
    padding-left: 22px;
    font-size: 12.5px;
  }
  li {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  li::marker {
    color: var(--faint);
  }
  .hop {
    all: unset;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hop:hover {
    text-decoration: underline;
  }
  .small {
    font-size: 11px;
  }
  .hist {
    width: calc(100% - 24px);
    margin: 2px 12px 8px;
    border-collapse: collapse;
    font-size: 11.5px;
  }
  .hist th {
    text-align: left;
    font-weight: normal;
    color: var(--faint);
  }
  .hist td,
  .hist th {
    padding: 1px 4px 1px 0;
  }
  .hist tbody tr {
    cursor: pointer;
  }
  .hist tbody tr:hover,
  .hist tr.sel {
    background: var(--hover, rgba(127, 127, 127, 0.12));
  }
</style>
