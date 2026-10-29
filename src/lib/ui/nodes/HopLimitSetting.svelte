<script lang="ts">
  import { MAX_HOPS } from '../../model/hops'
  import { app } from '../../state.svelte'

  // Rendered inside the node <dl>: a dt/dd pair.
  const current = $derived(app.session?.caps.hopLimit)
  let saving = $state<number | null>(null)
  let error = $state('')

  async function pick(n: number) {
    if (n === current || saving !== null) return
    saving = n
    error = ''
    try {
      await app.setHopLimit(n)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      saving = null
    }
  }
</script>

<dt>Hop limit</dt>
<dd>
  <span class="seg" title="Starting hop limit for everything this radio sends">
    {#each Array.from({ length: MAX_HOPS + 1 }, (_, i) => i) as n (n)}
      <button class="mono" class:on={n === current} class:saving={n === saving} disabled={saving !== null} onclick={() => pick(n)}>{n}</button>
    {/each}
  </span>
  {#if saving !== null}<span class="faint small">Saving…</span>{/if}
  {#if error}<div class="err small">{error}</div>{/if}
</dd>

<style>
  .seg {
    display: inline-flex;
  }
  .seg button {
    padding: 0 6px;
    border-radius: 0;
    margin-left: -1px;
  }
  .seg button:first-child {
    border-radius: 4px 0 0 4px;
    margin-left: 0;
  }
  .seg button:last-child {
    border-radius: 0 4px 4px 0;
  }
  .seg button.on {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .seg button.saving {
    color: var(--accent);
  }
  .seg button:disabled {
    cursor: default;
  }
  .small {
    font-size: 11px;
    margin-left: 6px;
  }
  .err {
    color: var(--danger);
    margin: 2px 0 0;
  }
</style>
