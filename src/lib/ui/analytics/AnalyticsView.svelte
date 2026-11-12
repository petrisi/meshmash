<script lang="ts">
  import { type ActivityRange, PACKET_TYPES, type RecordFilter } from '../../model/analytics'
  import { app } from '../../state.svelte'
  import ActivityView from './ActivityView.svelte'
  import TimeOfDayView from './TimeOfDayView.svelte'
  import TypeFilter from './TypeFilter.svelte'

  type Tab = 'activity' | 'time'
  const TABS: { id: Tab; label: string }[] = [
    { id: 'activity', label: 'Activity' },
    { id: 'time', label: 'Time of day' },
  ]

  let tab = $state<Tab>('activity')
  let range = $state<ActivityRange>('24h')
  let selected = $state<string[]>([])
  let repeats = $state(false)
  let counts = $state<Record<string, number>>({})
  let confirmClear = $state(false)

  const proto = $derived(app.protocol!)
  const filter = $derived<RecordFilter>({ types: selected.length ? new Set(selected) : null, repeats })
  const data = $derived(app.analytics)
  const empty = $derived(!!data && !data.records.length)

  $effect(() => {
    void app.loadAnalytics()
  })

  async function clear() {
    confirmClear = false
    await app.clearAnalytics()
  }
</script>

<div class="view">
  <div class="head">
    <div class="tabs" role="tablist">
      {#each TABS as t (t.id)}
        <button class="ghost" role="tab" aria-selected={tab === t.id} class:on={tab === t.id} onclick={() => (tab = t.id)}>{t.label}</button>
      {/each}
    </div>
    <span class="clear">
      {#if confirmClear}
        <span class="muted">Delete all analytics data of this radio?</span>
        <button class="danger" onclick={clear}>Delete</button>
        <button onclick={() => (confirmClear = false)}>Cancel</button>
      {:else}
        <button class="ghost" onclick={() => (confirmClear = true)} disabled={empty}>Clear data</button>
      {/if}
    </span>
  </div>

  {#if !data}
    <p class="faint">Loading…</p>
  {:else}
    <div class="filters">
      <TypeFilter types={PACKET_TYPES[proto]} {counts} bind:selected />
      {#if proto === 'meshcore'}
        <label class="muted" title="Count each copy of a packet heard via different repeaters">
          <input type="checkbox" bind:checked={repeats} /> Include repeats
        </label>
      {/if}
    </div>
    {#if empty}
      <p class="faint">No packets recorded yet. Packets are recorded while a radio is connected.</p>
    {/if}
    {#if tab === 'activity'}
      <ActivityView records={data.records} coverage={data.coverage} {filter} bind:range bind:counts />
    {:else if tab === 'time'}
      <TimeOfDayView records={data.records} coverage={data.coverage} {filter} bind:counts />
    {/if}
  {/if}
</div>

<style>
  .view {
    height: 100%;
    overflow-y: auto;
    padding: 10px 16px 16px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid var(--border);
    margin: 0 -16px 10px;
    padding: 0 16px;
  }
  .tabs {
    display: flex;
    gap: 2px;
  }
  .tabs button {
    padding: 6px 12px;
    border-radius: 0;
    border-bottom: 2px solid transparent;
    color: var(--muted);
  }
  .tabs button.on {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .clear {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .filters {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
  }
</style>
