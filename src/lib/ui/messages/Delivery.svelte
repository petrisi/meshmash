<script lang="ts">
  import { REPEAT_OK } from '../../model/capabilities'
  import type { Message } from '../../model/types'

  let { m }: { m: Message } = $props()

  const repeats = $derived(m.repeats ?? 0)
  const isDm = $derived(m.thread.startsWith('dm:'))

  // One state per message; DM recipient ACK outranks repeat counting.
  const state = $derived.by(() => {
    if (m.status === 'failed') return 'failed'
    if (isDm && m.status === 'acked') return 'delivered'
    if (!m.settled) return repeats ? 'counting' : 'waiting'
    if (repeats >= REPEAT_OK) return 'ok'
    return repeats ? 'weak' : 'none'
  })

  const TITLE: Record<string, string> = {
    waiting: 'Sent, listening for rebroadcasts',
    counting: 'Rebroadcasts heard so far',
    ok: 'Rebroadcast by multiple nodes',
    weak: 'Rebroadcast by one node',
    none: 'No rebroadcast heard',
    delivered: 'Delivered (recipient acknowledged)',
    failed: 'Not delivered',
  }
</script>

<span class="d {state}" title="{TITLE[state]}{repeats ? ` · ${repeats} heard` : ''}">
  {#if state === 'waiting' || state === 'counting'}
    <i class="spin"></i>
  {:else if state === 'delivered'}
    <b>✓✓</b>
  {:else if state === 'ok' || state === 'weak'}
    <b>✓</b>
  {:else}
    <b>✕</b>
  {/if}
  <span class="n">{repeats || ''}</span>
</span>

<style>
  .d {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    width: 100%;
  }
  .n {
    min-width: 1ch;
    text-align: right;
  }
  .spin {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--faint);
    border-top-color: var(--accent);
    animation: spin 0.9s linear infinite;
  }
  .counting .n {
    color: var(--accent);
  }
  .ok,
  .delivered {
    color: var(--good);
  }
  .weak {
    color: var(--fair);
  }
  .none,
  .failed {
    color: var(--danger);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
