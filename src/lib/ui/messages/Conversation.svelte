<script lang="ts">
  import { tick } from 'svelte'
  import { clock, dayLabel, snrClass } from '../../format'
  import type { Message, ThreadKey } from '../../model/types'
  import { app } from '../../state.svelte'
  import Badge from '../Badge.svelte'

  let { thread }: { thread: ThreadKey } = $props()

  let scroller: HTMLDivElement
  let draft = $state('')

  const msgs = $derived(app.byThread.get(thread) ?? [])
  const isDm = $derived(thread.startsWith('dm:'))
  const peer = $derived(isDm ? app.nodeById.get(thread.slice(3)) : undefined)
  const channel = $derived(isDm ? undefined : app.channels.find((c) => `ch:${c.index}` === thread))
  const title = $derived(peer?.longName ?? channel?.name ?? thread)
  const bytes = $derived(new TextEncoder().encode(draft).length)
  const maxBytes = $derived(app.session?.caps.messageMaxBytes ?? 200)

  // Group consecutive messages from the same sender within 5 min.
  function continues(prev: Message | undefined, m: Message) {
    return !!prev && prev.from === m.from && m.ts - prev.ts < 5 * 60_000
  }
  function newDay(prev: Message | undefined, m: Message) {
    return !prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString()
  }

  const STATUS: Record<Message['status'], string> = {
    pending: '○',
    sent: '◐',
    acked: '✓',
    failed: '✕',
    received: '',
  }

  $effect(() => {
    void msgs.length
    void thread
    tick().then(() => scroller && (scroller.scrollTop = scroller.scrollHeight))
  })

  function submit(e: SubmitEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text || bytes > maxBytes) return
    app.send(thread, text)
    draft = ''
  }
</script>

<section>
  <div class="head">
    {#if peer}
      <Badge id={peer.id} label={peer.shortName} />
      <b>{title}</b>
      <span class="mono faint">{peer.id}</span>
    {:else}
      <span class="hash mono">{channel?.kind === 'hashtag' ? '#' : channel?.index}</span>
      <b>{channel?.kind === 'hashtag' ? title.slice(1) : title}</b>
      <span class="faint">{channel?.encryption}</span>
    {/if}
    <span class="faint count">{msgs.length} messages</span>
  </div>

  <div class="scroll" bind:this={scroller}>
    {#each msgs as m, i (m.id)}
      {@const prev = msgs[i - 1]}
      {@const n = app.nodeById.get(m.from)}
      {@const mine = m.from === app.selfId}
      {#if newDay(prev, m)}
        <div class="day"><span>{dayLabel(m.ts)}</span></div>
      {/if}
      <div class="msg" class:mine class:cont={continues(prev, m) && !newDay(prev, m)}>
        <span class="t mono faint">{clock(m.ts)}</span>
        <span class="who">
          {#if !(continues(prev, m) && !newDay(prev, m))}
            <button class="ghost sender" onclick={() => n && app.showNode(n.id)}>
              <Badge id={m.from} label={n?.shortName ?? '?'} size={18} />
              <span class="nm">{mine ? 'You' : (n?.longName ?? m.from)}</span>
            </button>
          {/if}
        </span>
        <span class="text">{m.text}</span>
        <span class="meta mono">
          {#if m.hops !== undefined}<span class="faint" title="hops away">{m.hops ? `${m.hops} hop${m.hops > 1 ? 's' : ''}` : 'direct'}</span>{/if}
          {#if m.snr !== undefined}<span class={snrClass(m.snr)} title="SNR dB">{m.snr}</span>{/if}
          {#if mine}<span class="st {m.status}" title={m.status}>{STATUS[m.status]}</span>{/if}
        </span>
      </div>
    {/each}
  </div>

  <form onsubmit={submit}>
    <input
      bind:value={draft}
      placeholder={isDm ? `Message ${title}` : `Message ${title}`}
      autocomplete="off"
    />
    <span class="mono bytes" class:poor={bytes > maxBytes}>{bytes}/{maxBytes}</span>
    <button class="primary" disabled={!draft.trim() || bytes > maxBytes}>Send</button>
  </form>
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 40px;
    padding: 0 14px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .hash {
    color: var(--accent);
    font-size: 14px;
    font-weight: 700;
  }
  .count {
    margin-left: auto;
    font-size: 12px;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0 10px;
    display: flex;
    flex-direction: column;
  }
  /* Short threads sit at the bottom, next to the composer. */
  .scroll > :first-child {
    margin-top: auto;
  }
  .day {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 10px 14px 4px;
    font-size: 11px;
    color: var(--faint);
  }
  .day::before,
  .day::after {
    content: '';
    flex: 1;
    border-top: 1px solid var(--border);
  }
  .msg {
    display: grid;
    grid-template-columns: 38px 190px 1fr auto;
    gap: 8px;
    align-items: baseline;
    padding: 3px 14px 1px;
    border-left: 2px solid transparent;
  }
  .msg:not(.cont) {
    margin-top: 4px;
  }
  .msg:hover {
    background: var(--panel);
  }
  .msg.mine {
    background: var(--own);
    border-left-color: var(--accent);
  }
  .t {
    font-size: 11px;
    text-align: right;
  }
  .msg.cont .t {
    visibility: hidden;
  }
  .msg.cont:hover .t {
    visibility: visible;
  }
  .who {
    min-width: 0;
  }
  .sender {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    max-width: 100%;
    border: none;
  }
  .sender:hover .nm {
    text-decoration: underline;
  }
  .nm {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mine .nm {
    color: var(--accent);
  }
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    gap: 8px;
    font-size: 11px;
  }
  .st.acked {
    color: var(--good);
  }
  .st.failed {
    color: var(--danger);
  }
  .st.pending,
  .st.sent {
    color: var(--muted);
  }
  form {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px 14px;
    border-top: 1px solid var(--border);
  }
  form input {
    flex: 1;
    padding: 7px 10px;
  }
  .bytes {
    font-size: 11px;
    color: var(--faint);
  }
  form button {
    padding: 6px 16px;
  }
</style>
