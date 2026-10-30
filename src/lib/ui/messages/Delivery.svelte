<script lang="ts">
  import { canResend, deliveryState } from '../../model/delivery'
  import type { Message } from '../../model/types'
  import { app } from '../../state.svelte'

  let { m }: { m: Message } = $props()

  const repeats = $derived(m.repeats ?? 0)
  // Meshtastic reports only that someone relayed (implicit ACK), not how many.
  const counts = $derived(app.protocol !== 'meshtastic')
  const state = $derived(deliveryState(m, app.protocol))
  const resend = $derived(canResend(m, app.selfId))
  const attempt = $derived(m.attempt ? ` · attempt ${m.attempt + 1}` : '')

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

<span class="d {state}" title="{TITLE[state]}{state === 'ok' && m.thread.startsWith('dm:') ? '; recipient has not confirmed' : ''}{counts && repeats ? ` · ${repeats} heard` : ''}{attempt}">
  {#if resend}
    <button class="ghost again" title="Resend{attempt}" disabled={!app.canResend} onclick={() => app.resend(m)}>↻</button>
  {/if}
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
  .again {
    padding: 0 2px;
    line-height: 1;
    font-size: 12px;
    color: var(--muted);
  }
  .again:hover:not(:disabled) {
    color: var(--accent);
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
