<script lang="ts">
  import { clock } from '../format'
  import { app } from '../state.svelte'

  // Most recent entry worth showing: skip raw traffic.
  const last = $derived(app.log.findLast((e) => e.dir === 'info' || e.dir === 'error'))
</script>

<footer>
  <span class="mono">{app.session?.transport}</span>
  <span class="sep"></span>
  {#if last}
    <span class="faint mono">{clock(last.ts)}</span>
    <span class:poor={last.dir === 'error'}>{last.summary}</span>
  {/if}
  <span class="spacer"></span>
  <button class="ghost" onclick={() => (app.view = 'log')}>{app.log.length} log entries</button>
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
  .spacer {
    flex: 1;
  }
  button {
    padding: 0 6px;
    font-size: 11px;
    color: var(--muted);
  }
</style>
