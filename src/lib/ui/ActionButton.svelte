<script lang="ts">
  import { app } from '../state.svelte'

  /** Button for a radio or node action that shows sending, done and failed states. */
  let { action, nodeId, label }: { action: string; nodeId: string; label: string } = $props()

  const SHOW_OK_MS = 4000
  const SHOW_FAIL_MS = 10_000

  const r = $derived(app.results[nodeId]?.[action])
  const state = $derived.by(() => {
    if (!r) return 'idle'
    if (r.state === 'pending') return 'pending'
    const age = app.now - r.ts
    if (r.state === 'ok' && age < SHOW_OK_MS) return 'ok'
    if (r.state === 'failed' && age < SHOW_FAIL_MS) return 'failed'
    return 'idle'
  })
</script>

<button
  class={state}
  disabled={state === 'pending'}
  title={state === 'idle' ? undefined : (r?.text ?? '')}
  onclick={() => app.runAction(action, nodeId)}
>
  {#if state === 'pending'}<i class="spin"></i>{:else if state === 'ok'}<b>✓</b>{:else if state === 'failed'}<b>✕</b>{/if}
  {label}
</button>

<style>
  button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .ok {
    border-color: var(--good);
    color: var(--good);
  }
  .failed {
    border-color: var(--danger);
    color: var(--danger);
  }
  .spin {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1.5px solid var(--faint);
    border-top-color: var(--accent);
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
