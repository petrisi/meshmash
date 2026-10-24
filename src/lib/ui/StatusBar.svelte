<script lang="ts">
  import { clock } from '../format'
  import { app } from '../state.svelte'

  const last = $derived(app.log.at(-1))
</script>

<footer>
  <span class="mono">{app.session?.transport}</span>
  <span class="sep"></span>
  {#if last}
    <span class="faint mono">{clock(last.ts)}</span>
    <span>{last.text}</span>
  {/if}
</footer>

<style>
  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 22px;
    padding: 0 10px;
    font-size: 11.5px;
    color: var(--muted);
    background: var(--panel);
    border-top: 1px solid var(--border);
    white-space: nowrap;
    overflow: hidden;
  }
  .sep {
    width: 1px;
    height: 12px;
    background: var(--border);
  }
</style>
