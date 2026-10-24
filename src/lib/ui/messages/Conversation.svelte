<script lang="ts">
  import { tick } from 'svelte'
  import { clock, dayLabel, initials, snrClass } from '../../format'
  import type { Message, ThreadKey } from '../../model/types'
  import { app } from '../../state.svelte'
  import Badge from '../Badge.svelte'
  import Delivery from './Delivery.svelte'

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

  const isMt = $derived(app.protocol === 'meshtastic')

  function hops(m: Message) {
    if (m.hops === undefined) return ''
    return m.hopStart !== undefined ? `${m.hops}/${m.hopStart}` : `${m.hops}`
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

  <div class="colhead">
    <div class="msg cols" class:mt={isMt}>
      <span></span><span></span><span></span>
      <span title={isMt ? 'hops taken / hop limit at start' : 'path length'}>hops</span>
      <span>SNR</span>
      {#if isMt}<span>RSSI</span>{/if}
      <span title="rebroadcasts heard">rpt</span>
    </div>
  </div>

  <div class="scroll" bind:this={scroller}>
    {#each msgs as m, i (m.id)}
      {@const prev = msgs[i - 1]}
      {@const n = app.nodeById.get(m.from)}
      {@const mine = m.from === app.selfId}
      {#if newDay(prev, m)}
        <div class="day"><span>{dayLabel(m.ts)}</span></div>
      {/if}
      <div class="msg" class:mt={isMt} class:mine class:cont={continues(prev, m) && !newDay(prev, m)}>
        <span class="t mono faint">{clock(m.ts)}</span>
        <span class="who">
          {#if !(continues(prev, m) && !newDay(prev, m))}
            <button class="ghost sender" onclick={() => n && app.showNode(n.id)}>
              <Badge id={m.from} label={n?.shortName ?? initials(m.fromName ?? '?')} size={18} />
              <span class="nm">{mine ? 'You' : (n?.longName ?? m.fromName ?? m.from)}</span>
            </button>
          {/if}
        </span>
        <span class="text">{m.text}</span>
        <span class="c mono muted">{hops(m)}</span>
        <span class="c mono {snrClass(m.snr)}">{m.snr ?? ''}</span>
        {#if isMt}<span class="c mono muted">{m.rssi ?? ''}</span>{/if}
        <span class="c mono">{#if mine}<Delivery {m} />{/if}</span>
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
    scrollbar-gutter: stable;
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
    /* time | sender | text | hops | snr | rpt  (+ rssi for Meshtastic) */
    grid-template-columns: 38px 190px 1fr 40px 48px 40px;
    gap: 8px;
    align-items: baseline;
    padding: 3px 14px 1px;
    border-left: 2px solid transparent;
  }
  .msg.mt {
    grid-template-columns: 38px 190px 1fr 40px 48px 40px 40px;
  }
  .colhead {
    overflow-y: hidden;
    scrollbar-gutter: stable;
  }
  .msg.cols {
    margin: 0;
    padding-top: 4px;
    padding-bottom: 3px;
    background: var(--bg);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--faint);
    border-bottom: 1px solid var(--border);
  }
  .msg.cols > span:nth-child(n + 4) {
    text-align: right;
  }
  .msg.cols:hover {
    background: var(--bg);
  }
  .c {
    font-size: 11px;
    text-align: right;
    white-space: nowrap;
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
