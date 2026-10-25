<script lang="ts">
  import { REPEAT_OK } from '../../model/capabilities'
  import type { Message } from '../../model/types'
  import { app } from '../../state.svelte'

  let { m }: { m: Message } = $props()

  const repeats = $derived(m.repeats ?? 0)
  const isDm = $derived(m.thread.startsWith('dm:'))
  // Meshtastic reports only that someone relayed (implicit ACK), not how many.
  const counts = $derived(app.protocol !== 'meshtastic')

  // One state per message; DM recipient ACK outranks repeat counting.
  const state = $derived.by(() => {
    if (m.status === 'failed') return 'failed'
    if (m.status === 'pending') return m.settled ? 'unknown' : 'queued'
    if (isDm && m.status === 'acked') return 'delivered'
    // Hop limit 0: no relay and no ACK to wait for.
    if (m.hopLimit === 0) return 'direct'
    if (repeats >= REPEAT_OK && (m.settled || !counts)) return 'ok'
    if (!m.settled) return repeats ? 'counting' : 'waiting'
    return repeats ? 'weak' : 'none'
  })

  const TITLE: Record<string, string> = {
    queued: 'Waiting for the radio to take the message',
    unknown: 'Outcome unknown (disconnected before the radio took it)',
    waiting: 'Sent, listening for rebroadcasts',
    counting: 'Rebroadcasts heard so far',
    ok: 'Rebroadcast heard',
    weak: 'Too few rebroadcasts heard',
    none: 'No rebroadcast heard',
    delivered: 'Delivered (recipient acknowledged)',
    failed: 'Not delivered',
    direct: 'Sent to direct neighbours only (hop limit 0); no delivery receipt',
  }
</script>

<span class="d {state}" title="{TITLE[state]}{counts && repeats ? ` · ${repeats} heard` : ''}">
  {#if state === 'queued' || state === 'waiting' || state === 'counting'}
    <i class="spin"></i>
  {:else if state === 'delivered'}
    <b>✓✓</b>
  {:else if state === 'ok' || state === 'weak' || state === 'direct'}
    <b>✓</b>
  {:else if state === 'unknown'}
    <b>?</b>
  {:else}
    <b>✕</b>
  {/if}
  <span class="n">{counts && repeats ? repeats : ''}</span>
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
  .queued .spin {
    border-top-color: var(--faint);
    animation-duration: 2.4s;
  }
  .counting .n {
    color: var(--accent);
  }
  .ok,
  .delivered {
    color: var(--good);
  }
  .direct {
    color: var(--muted);
  }
  .weak,
  .unknown {
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
