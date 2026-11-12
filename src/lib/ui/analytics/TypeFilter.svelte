<script lang="ts">
  import type { PacketType } from '../../model/analytics'

  let {
    types,
    counts,
    selected = $bindable(),
  }: {
    types: PacketType[]
    /** Packets per type in the current view. */
    counts: Record<string, number>
    /** Empty: all types. */
    selected: string[]
  } = $props()

  const toggle = (id: string) => (selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  const total = $derived(Object.values(counts).reduce((s, n) => s + n, 0))
</script>

<div class="chips" role="group" aria-label="Packet types">
  <button class:on={!selected.length} onclick={() => (selected = [])}>All <span class="faint">{total}</span></button>
  {#each types as t (t.id)}
    <button class:on={selected.includes(t.id)} aria-pressed={selected.includes(t.id)} onclick={() => toggle(t.id)}>
      {t.label} <span class="faint">{counts[t.id] ?? 0}</span>
    </button>
  {/each}
</div>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  button {
    padding: 2px 9px;
    border-radius: 12px;
    font-size: 12px;
  }
  button.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
