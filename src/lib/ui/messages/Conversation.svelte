<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { clock, dayLabel, initials, snrClass } from '../../format'
  import { hopSuggestion } from '../../model/hops'
  import { guessRelay, relayByte, relayNames } from '../../model/relay'
  import type { Message, ThreadKey } from '../../model/types'
  import { app } from '../../state.svelte'
  import { loadHopLimit, saveHopLimit } from '../../store/hopLimits'
  import Badge from '../Badge.svelte'
  import Delivery from './Delivery.svelte'
  import HopPicker from './HopPicker.svelte'

  let { thread }: { thread: ThreadKey } = $props()

  let scroller: HTMLDivElement
  let input: HTMLInputElement
  let draft = $state('')
  let replyTo = $state<Message | null>(null)
  let picking = $state<string | null>(null)
  $effect(() => {
    void thread
    replyTo = null
    picking = null
  })

  const msgs = $derived(app.byThread.get(thread) ?? [])
  const isDm = $derived(thread.startsWith('dm:'))
  const peer = $derived(isDm ? app.nodeById.get(thread.slice(3)) : undefined)
  const channel = $derived(isDm ? undefined : app.channels.find((c) => `ch:${c.index}` === thread))
  const title = $derived(peer?.longName ?? channel?.name ?? thread)
  const isMt = $derived(app.protocol === 'meshtastic')
  const nameOf = (m: Message) =>
    m.from === app.selfId ? 'You' : (app.nodeById.get(m.from)?.longName ?? m.fromName ?? m.from)
  /** MeshCore has no reply field; the convention is an @[name] mention. */
  const prefix = $derived(replyTo && !isMt ? `@[${nameOf(replyTo)}] ` : '')
  const bytes = $derived(new TextEncoder().encode(prefix + draft).length)
  // MeshCore: channel text carries "<our name>: " (in caps), room posts are capped at 151.
  const maxBytes = $derived(
    isMt || !isDm ? (app.session?.caps.messageMaxBytes ?? 200) : peer?.kind === 'room' ? 151 : 160,
  )
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

  // Meshtastic hop limit: the radio default unless overridden. A DM keeps its choice;
  // on a channel it applies to the next message only.
  const defHops = $derived(isMt ? app.session?.caps.hopLimit : undefined)
  const radio = $derived(app.session?.info.nodeId)
  let override = $state<number | null>(null)
  $effect(() => {
    override = isDm && radio ? loadHopLimit(radio, thread) : null
  })
  const hopLimit = $derived(override ?? defHops)
  /** How far away the other side was heard: the replied message, else the DM peer. */
  const far = $derived.by(() => {
    if (replyTo && replyTo.from !== app.selfId) return { hops: replyTo.hops, who: nameOf(replyTo) }
    if (!peer) return undefined
    const heard = peer.hops ?? msgs.findLast((m) => m.from === peer.id && m.hops !== undefined)?.hops
    return { hops: heard, who: peer.longName }
  })
  const suggest = $derived(hopLimit === undefined ? undefined : hopSuggestion(hopLimit, far?.hops))
  function setHops(n: number) {
    override = n === defHops ? null : n
    if (isDm && radio) saveHopLimit(radio, thread, override)
    input?.focus()
  }
  /** Hop limit to send with; a channel's one-off choice is used up. */
  function useHops() {
    const h = override ?? undefined
    if (!isDm) override = null
    return h
  }
  function keydown(e: KeyboardEvent) {
    if (e.key === 'Escape') replyTo = null
    else if (defHops !== undefined && e.altKey && /^Digit[0-7]$/.test(e.code)) {
      e.preventDefault()
      setHops(Number(e.code.slice(5)))
    }
  }
  const byPacket = $derived(new Map(msgs.filter((m) => m.packetId !== undefined).map((m) => [m.packetId!, m])))

  /** Splits text into plain parts and @[name] mentions. */
  function parts(text: string) {
    return text.split(/(@\[[^\]]+\])/).filter(Boolean)
  }
  function grouped(m: Message) {
    const g = new Map<string, string[]>()
    for (const r of m.reactions ?? []) g.set(r.emoji, [...(g.get(r.emoji) ?? []), r.from === app.selfId ? 'You' : (app.nodeById.get(r.from)?.longName ?? r.from)])
    return [...g]
  }
  function startReply(m: Message) {
    replyTo = m
    picking = null
    input?.focus()
  }

  // Group consecutive messages from the same sender within 5 min.
  function continues(prev: Message | undefined, m: Message) {
    return !!prev && prev.from === m.from && m.ts - prev.ts < 5 * 60_000
  }
  function newDay(prev: Message | undefined, m: Message) {
    return !prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString()
  }

  function hops(m: Message) {
    if (m.hops === undefined) return ''
    return m.hopStart !== undefined ? `${m.hops}/${m.hopStart}` : `${m.hops}`
  }

  // Meshtastic relay byte → candidate nodes, grouped once per node list change.
  const byRelayByte = $derived.by(() => {
    const g = new Map<number, typeof app.nodes>()
    for (const n of app.nodes) {
      const b = relayByte(n.id)
      if (b !== undefined) g.set(b, [...(g.get(b) ?? []), n])
    }
    return g
  })
  /** Who our radio heard the message from: the sender itself, or "[likely ]zeb3 or koik". */
  function relayOf(m: Message): { direct: true } | { direct: false; text: string; likely: boolean } | undefined {
    if (m.relay === undefined || m.from === app.selfId) return undefined
    if (m.relay === relayByte(m.from) && (m.hops ?? 0) === 0) return { direct: true }
    const g = guessRelay(m.relay, byRelayByte.get(m.relay) ?? [], app.nodeById.get(app.selfId), m.from)
    return { direct: false, text: relayNames(g), likely: g.likely }
  }
  function hopsTitle(m: Message) {
    const r = relayOf(m)
    const used =
      m.hopStart === undefined
        ? `${m.hops} hop${m.hops === 1 ? '' : 's'}`
        : m.hops === 0 && r?.direct !== false
          ? `Heard directly · sender's hop limit ${m.hopStart}`
          : `${m.hops} of ${m.hopStart} hops used`
    return r && !r.direct ? `${used} · ${r.likely ? 'likely ' : ''}via ${r.text}` : used
  }
  function signalTitle(m: Message) {
    const r = relayOf(m)
    if (!r) return undefined
    if (r.direct) return `Signal from ${app.nodeById.get(m.from)?.shortName ?? m.from}`
    return `Signal ${r.likely ? 'likely ' : ''}from ${r.text}`
  }

  // Captured when the thread opens: the divider stays put while reading.
  const mark = untrack(() => (app.readMark?.thread === thread ? app.readMark.ts : null))
  let opened = false
  $effect(() => {
    void msgs.length
    tick().then(() => {
      if (!scroller) return
      if (!opened) {
        opened = true
        const target = scroller.querySelector(app.focus ? `#m-${CSS.escape(app.focus.id)}` : '.newdiv')
        if (target) return target.scrollIntoView({ block: 'center' })
      } else if (msgs.at(-1)?.from !== app.selfId && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 150) {
        return // reading older messages: do not jump to new arrivals
      }
      scroller.scrollTop = scroller.scrollHeight
    })
  })
  // Search jumps within the open thread.
  $effect(() => {
    const f = app.focus
    if (!f || !opened) return
    tick().then(() => scroller?.querySelector(`#m-${CSS.escape(f.id)}`)?.scrollIntoView({ block: 'center' }))
  })

  function submit(e: SubmitEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text || bytes > maxBytes) return
    app.send(thread, prefix + text, isMt ? (replyTo ?? undefined) : undefined, useHops())
    draft = ''
    replyTo = null
  }
</script>

<section>
  <div class="head">
    {#if peer}
      <Badge id={peer.id} label={peer.shortName} />
      <b>{title}</b>
      <span class="mono faint">{peer.id}</span>
    {:else}
      <span class="hash mono">{channel?.index}</span>
      <b>{title}</b>
      <span class="faint">{channel?.encryption}</span>
      {#if channel && app.canEditChannels}
        <button class="ghost pencil" title="Edit channel" onclick={() => app.editChannel(channel.index)}>✎</button>
      {/if}
    {/if}
    {#if peer && isMt}
      <span class="faint" title="Meshtastic DMs use the node's public key when both sides know each other's keys">
        {peer.publicKey ? '🔒 public key' : 'no public key known'}
      </span>
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
      {#if mark !== null && m.ts > mark && (!prev || prev.ts <= mark)}
        <div class="day newdiv"><span>New messages</span></div>
      {/if}
      <div id="m-{m.id}" class="msg" class:focus={app.focus?.id === m.id} class:mt={isMt} class:mine class:cont={continues(prev, m) && !newDay(prev, m)}>
        <span class="t mono faint">{clock(m.ts)}</span>
        <span class="who">
          {#if !(continues(prev, m) && !newDay(prev, m))}
            <button class="ghost sender" onclick={() => n && app.showNode(n.id)}>
              <Badge id={m.from} label={n?.shortName ?? initials(m.fromName ?? '?')} size={18} />
              <span class="nm">{mine ? 'You' : (n?.longName ?? m.fromName ?? m.from)}</span>
            </button>
          {/if}
        </span>
        <span class="text">
          {#if m.replyTo !== undefined}
            {@const q = byPacket.get(m.replyTo)}
            <span class="quote faint">↪ {q ? `${nameOf(q)}: ${q.text}` : 'earlier message'}</span>
          {/if}
          {#if m.pki}<span class="lock" title="Encrypted with the public key">🔒</span>{/if}
          {#each parts(m.text) as p, j (j)}
            {#if p.startsWith('@[')}<span class="mention" class:me={p === `@[${app.session?.info.longName}]`}>{p}</span>{:else}{p}{/if}
          {/each}
          {#if m.reactions?.length}
            <span class="reacts">
              {#each grouped(m) as [emoji, who] (emoji)}
                <span class="react" title={who.join(', ')}>{emoji}{who.length > 1 ? ` ${who.length}` : ''}</span>
              {/each}
            </span>
          {/if}
          <span class="acts">
            <!-- Meshtastic replies refer to the packet id; older history may not have one. -->
            {#if !isMt || m.packetId !== undefined}
              <button class="ghost" title="Reply" onclick={() => startReply(m)}>↩</button>
            {/if}
            {#if isMt && m.packetId !== undefined}
              <button class="ghost" title="React" onclick={() => (picking = picking === m.id ? null : m.id)}>☺</button>
            {/if}
            {#if picking === m.id}
              {#each REACTIONS as e (e)}
                <button class="ghost" onclick={() => {
                  app.react(m, e, useHops())
                  picking = null
                }}>{e}</button>
              {/each}
            {/if}
          </span>
        </span>
        {#if m.hopLimit !== undefined}
          <span class="c mono muted" title="Sent with hop limit {m.hopLimit}">⤳{m.hopLimit}</span>
        {:else}
          <span class="c mono muted" class:relayed={relayOf(m)?.direct === false} title={m.hops === undefined ? undefined : hopsTitle(m)}>{hops(m)}</span>
        {/if}
        <span class="c mono {snrClass(m.snr)}" title={m.snr === undefined ? undefined : signalTitle(m)}>{m.snr ?? ''}</span>
        {#if isMt}<span class="c mono muted" title={m.rssi === undefined ? undefined : signalTitle(m)}>{m.rssi ?? ''}</span>{/if}
        <span class="c mono">{#if mine}<Delivery {m} />{/if}</span>
      </div>
    {/each}
  </div>

  {#if replyTo}
    <div class="replying">
      <span class="faint">Replying to</span>
      <b>{nameOf(replyTo)}</b>
      <span class="snip faint">{replyTo.text}</span>
      <button class="ghost" title="Cancel reply" onclick={() => (replyTo = null)}>✕</button>
    </div>
  {/if}
  <form onsubmit={submit}>
    <input
      bind:this={input}
      onkeydown={keydown}
      bind:value={draft}
      placeholder={isDm ? `Message ${title}` : `Message ${title}`}
      autocomplete="off"
    />
    <span class="mono bytes" class:poor={bytes > maxBytes}>{bytes}/{maxBytes}</span>
    {#if defHops !== undefined && hopLimit !== undefined}
      <HopPicker
        value={hopLimit}
        def={defHops}
        {suggest}
        reason={far?.hops === undefined
          ? undefined
          : far.hops === 0
            ? `${far.who} was heard directly`
            : `${far.who} was heard ${far.hops} hop${far.hops === 1 ? '' : 's'} away`}
        sticky={isDm}
        onpick={setHops}
      />
    {/if}
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
  .pencil {
    padding: 0 6px;
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
  .newdiv {
    color: var(--accent);
  }
  .newdiv::before,
  .newdiv::after {
    border-color: var(--accent) !important;
  }
  .msg.focus {
    animation: flash 2.5s ease-out;
  }
  @keyframes flash {
    from {
      background: var(--accent-soft);
    }
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
  .relayed {
    text-decoration: underline dotted;
    text-underline-offset: 2px;
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
    position: relative;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .quote {
    display: block;
    font-size: 11.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lock {
    font-size: 10px;
    margin-right: 4px;
  }
  .mention {
    color: var(--accent);
  }
  .mention.me {
    font-weight: 700;
  }
  .reacts {
    display: flex;
    gap: 4px;
    margin-top: 2px;
  }
  .react {
    font-size: 12px;
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 9px;
  }
  .acts {
    position: absolute;
    top: -2px;
    right: 0;
    display: none;
    gap: 2px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .acts button {
    padding: 0 5px;
    border: none;
  }
  .msg:hover .acts {
    display: flex;
  }
  .replying {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 6px 14px 0;
    font-size: 12px;
    min-width: 0;
  }
  .snip {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
