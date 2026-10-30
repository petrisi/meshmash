<script lang="ts">
  import { ago } from '../../format'
  import { orderDms } from '../../model/dmOrder'
  import type { Message, ThreadKey } from '../../model/types'
  import { app } from '../../state.svelte'
  import Badge from '../Badge.svelte'

  const lastOf = (k: ThreadKey) => app.byThread.get(k)?.at(-1)

  const dms = $derived(
    orderDms(app.dmPeers, app.dmPins, (id) => lastOf(`dm:${id}`)?.ts).map((id) => ({
      id,
      node: app.nodeById.get(id),
      last: lastOf(`dm:${id}`),
      pinned: app.dmPins.includes(id),
    })),
  )

  // Drag to reorder pinned threads: mouse after a few pixels, touch after a long press.
  let drag = $state<{ id: string; to: number } | null>(null)
  let press: { id: string; x: number; y: number; timer?: ReturnType<typeof setTimeout>; el: HTMLElement; pointer: number } | null = null
  let dragged = false
  let rows: HTMLElement[] = $state([])

  function pointerdown(e: PointerEvent, id: string) {
    dragged = false
    if (!app.dmPins.includes(id) || e.button !== 0) return
    const el = e.currentTarget as HTMLElement
    press = { id, x: e.clientX, y: e.clientY, el, pointer: e.pointerId }
    if (e.pointerType === 'touch') press.timer = setTimeout(() => startDrag(), 400)
  }
  function startDrag() {
    if (!press) return
    press.el.setPointerCapture(press.pointer)
    drag = { id: press.id, to: app.dmPins.indexOf(press.id) }
    dragged = true
  }
  function pointermove(e: PointerEvent) {
    if (!press) return
    if (!drag) {
      const far = Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5
      if (far && e.pointerType === 'touch') return cancel() // a scroll, not a long press
      if (far) startDrag()
      if (!drag) return
    }
    e.preventDefault()
    // Target slot: the first pinned row whose middle is below the pointer.
    const pinnedRows = rows.slice(0, app.dmPins.length)
    let to = pinnedRows.findIndex((r) => {
      const b = r.getBoundingClientRect()
      return e.clientY < b.top + b.height / 2
    })
    if (to < 0) to = pinnedRows.length
    const from = app.dmPins.indexOf(drag.id)
    drag.to = to > from ? to - 1 : to
  }
  function pointerup() {
    if (drag) app.moveDm(drag.id, drag.to)
    cancel()
  }
  function cancel() {
    if (press?.timer) clearTimeout(press.timer)
    press = null
    drag = null
  }
  // A touch drag must not scroll the list; touchmove listeners are passive unless added like this.
  let aside: HTMLElement
  $effect(() => {
    const stop = (e: TouchEvent) => drag && e.preventDefault()
    aside.addEventListener('touchmove', stop, { passive: false })
    return () => aside.removeEventListener('touchmove', stop)
  })
  function click(id: string) {
    if (dragged) return void (dragged = false)
    app.openThread(`dm:${id}`)
  }
  /** Where the dragged row would land: a line above row i, or below the last pinned row. */
  function dropLine(i: number): 'above' | 'below' | null {
    if (!drag) return null
    const from = app.dmPins.indexOf(drag.id)
    const slot = drag.to >= from ? drag.to + 1 : drag.to
    if (slot === from || slot === from + 1) return null
    if (slot === i) return 'above'
    return slot === app.dmPins.length && i === app.dmPins.length - 1 ? 'below' : null
  }

  const PIN = 'M9 3h6l-1 6 3 3v2H7v-2l3-3zM12 14v7'

  let query = $state('')
  const results = $derived.by(() => {
    const q = query.trim().toLocaleLowerCase()
    if (!q) return []
    const out = []
    for (let i = app.messages.length - 1; i >= 0 && out.length < 100; i--) {
      const m = app.messages[i]
      if (m.text.toLocaleLowerCase().includes(q)) out.push(m)
    }
    return out
  })
  function threadName(k: ThreadKey) {
    if (k.startsWith('dm:')) return app.nodeById.get(k.slice(3))?.longName ?? k.slice(3)
    return app.channels.find((c) => `ch:${c.index}` === k)?.name ?? k
  }
  function sender(m: Message) {
    return m.from === app.selfId ? 'You' : (app.nodeById.get(m.from)?.shortName ?? m.fromName ?? '?')
  }

  function preview(k: ThreadKey) {
    const m = lastOf(k)
    if (!m) return ''
    const who = m.from === app.selfId ? 'You' : (app.nodeById.get(m.from)?.shortName ?? m.fromName ?? '?')
    return k.startsWith('dm:') && m.from !== app.selfId ? m.text : `${who}: ${m.text}`
  }
</script>

<aside bind:this={aside}>
  <input
    class="search"
    type="search"
    placeholder="Search messages"
    bind:value={query}
    onkeydown={(e) => e.key === 'Escape' && (query = '')}
  />
  {#if query.trim()}
    <div class="section">
      <span>Results</span>
      <span class="faint">{results.length}{results.length === 100 ? '+' : ''}</span>
    </div>
    {#each results as m (m.id)}
      <button class="row ghost" class:active={app.focus?.id === m.id} onclick={() => app.showMessage(m)}>
        <span class="main">
          <span class="top">
            <span class="name">{threadName(m.thread)}</span>
            <span class="time faint">{ago(m.ts, app.now)}</span>
          </span>
          <span class="preview muted">{sender(m)}: {m.text}</span>
        </span>
      </button>
    {:else}
      <p class="faint empty">No messages match.</p>
    {/each}
  {:else}
  <div class="section">
    <span>Channels</span>
    <span class="faint">
      {app.channels.length}/{app.session?.caps.maxChannels}
      {#if app.canEditChannels}
        <button
          class="ghost add"
          title={app.freeChannelSlots.length ? 'Add a channel' : 'No free slots'}
          disabled={!app.freeChannelSlots.length}
          onclick={() => app.editChannel()}>+</button
        >
      {/if}
    </span>
  </div>
  {#each app.channels as ch (ch.index)}
    {@const k = `ch:${ch.index}` as const}
    {@const u = app.unread(k)}
    <button class="row ghost" class:active={app.activeThread === k} onclick={() => app.openThread(k)}>
      <span class="icon mono">{ch.index}</span>
      <span class="main">
        <span class="top">
          <span class="name" class:unread={u}>{ch.name}</span>
          {#if ch.muted}<span class="faint small">muted</span>{/if}
          <span class="time faint">{ago(lastOf(k)?.ts, app.now)}</span>
        </span>
        <span class="preview muted">{preview(k)}</span>
      </span>
      {#if u}<b class="count" class:dim={ch.muted}>{u}</b>{/if}
    </button>
  {/each}

  <div class="section">
    <span>Direct messages</span>
    <span class="faint">{dms.length}</span>
  </div>
  {#each dms as d, i (d.id)}
    {@const k = `dm:${d.id}` as const}
    {@const u = app.unread(k)}
    {@const line = dropLine(i)}
    <div class="dm" class:counted={!!u} class:above={line === 'above'} class:below={line === 'below'} bind:this={rows[i]}>
      <button
        class="row ghost"
        class:active={app.activeThread === k}
        class:dragging={drag?.id === d.id}
        onclick={() => click(d.id)}
        onpointerdown={(e) => pointerdown(e, d.id)}
        onpointermove={pointermove}
        onpointerup={pointerup}
        onpointercancel={cancel}
        oncontextmenu={(e) => drag && e.preventDefault()}
      >
        <Badge id={d.id} label={d.node?.shortName ?? '?'} size={26} />
        <span class="main">
          <span class="top">
            <span class="name" class:unread={u}>{d.node?.longName ?? d.id}</span>
            {#if d.pinned}<svg class="mark" viewBox="0 0 24 24" width="11" height="11"><title>Pinned</title><path d={PIN} /></svg>{/if}
            <span class="time faint">{ago(d.last?.ts, app.now)}</span>
          </span>
          <span class="preview muted">{preview(k)}</span>
        </span>
        {#if u}<b class="count">{u}</b>{/if}
      </button>
      <button
        class="pin ghost"
        title={d.pinned ? 'Unpin · drag to reorder' : 'Pin to top'}
        onclick={() => app.pinDm(d.id, !d.pinned)}
      >
        <svg viewBox="0 0 24 24" width="13" height="13"><path d={PIN} /></svg>
      </button>
    </div>
  {:else}
    <p class="faint empty">Open a node and choose “Direct message”.</p>
  {/each}
  {/if}
</aside>

<style>
  aside {
    overflow-y: auto;
    background: var(--panel);
    border-right: 1px solid var(--border);
    padding-bottom: 8px;
  }
  .add {
    padding: 0 6px;
    margin-left: 4px;
    font-size: 14px;
    line-height: 1;
  }
  .search {
    width: calc(100% - 16px);
    margin: 8px 8px 2px;
    padding: 5px 8px;
  }
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    border-radius: 0;
    text-align: left;
    border: none;
    border-left: 2px solid transparent;
  }
  .dm {
    position: relative;
  }
  .dm.above::before,
  .dm.below::after {
    content: '';
    position: absolute;
    left: 8px;
    right: 8px;
    height: 2px;
    background: var(--accent);
    z-index: 1;
  }
  .dm.above::before {
    top: -1px;
  }
  .dm.below::after {
    bottom: -1px;
  }
  .row.dragging {
    opacity: 0.5;
  }
  .pin {
    position: absolute;
    top: 4px;
    right: 8px;
    padding: 2px 4px;
    line-height: 0;
    border-radius: 3px;
    background: var(--panel-2);
    opacity: 0;
  }
  .dm.counted .pin {
    right: 40px;
  }
  .dm:hover .pin,
  .pin:focus-visible {
    opacity: 1;
  }
  .pin svg,
  .mark {
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }
  .mark {
    color: var(--accent);
    align-self: center;
  }
  .row.active {
    background: var(--accent-soft);
    border-left-color: var(--accent);
  }
  .icon {
    width: 26px;
    height: 26px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 4px;
    background: var(--panel-2);
    color: var(--muted);
    font-weight: 600;
  }
  .active .icon {
    color: var(--accent);
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .top {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name.unread {
    font-weight: 600;
  }
  .time {
    margin-left: auto;
    font-size: 11px;
    flex: none;
  }
  .small {
    font-size: 10.5px;
  }
  .preview {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    flex: none;
    min-width: 18px;
    padding: 0 5px;
    border-radius: 9px;
    font-size: 11px;
    line-height: 18px;
    text-align: center;
    background: var(--accent);
    color: var(--accent-ink);
  }
  .count.dim {
    background: var(--panel-2);
    color: var(--muted);
  }
  .empty {
    padding: 4px 12px;
    margin: 0;
    font-size: 12px;
  }
</style>
