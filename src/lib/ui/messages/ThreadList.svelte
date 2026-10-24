<script lang="ts">
  import { ago } from '../../format'
  import type { ThreadKey } from '../../model/types'
  import { app } from '../../state.svelte'
  import Badge from '../Badge.svelte'

  const lastOf = (k: ThreadKey) => app.byThread.get(k)?.at(-1)

  const dms = $derived(
    app.dmPeers
      .map((id) => ({ id, node: app.nodeById.get(id), last: lastOf(`dm:${id}`) }))
      // Newly opened threads without messages sort first.
      .sort((a, b) => (b.last?.ts ?? Number.MAX_SAFE_INTEGER) - (a.last?.ts ?? Number.MAX_SAFE_INTEGER)),
  )

  function preview(k: ThreadKey) {
    const m = lastOf(k)
    if (!m) return ''
    const who = m.from === app.selfId ? 'You' : (app.nodeById.get(m.from)?.shortName ?? m.fromName ?? '?')
    return k.startsWith('dm:') && m.from !== app.selfId ? m.text : `${who}: ${m.text}`
  }
</script>

<aside>
  <div class="section">
    <span>Channels</span>
    <span class="faint">{app.channels.length}/{app.session?.caps.maxChannels}</span>
  </div>
  {#each app.channels as ch (ch.index)}
    {@const k = `ch:${ch.index}` as const}
    {@const u = app.unread(k)}
    <button class="row ghost" class:active={app.activeThread === k} onclick={() => app.openThread(k)}>
      <span class="icon mono">{ch.kind === 'hashtag' ? '#' : ch.index}</span>
      <span class="main">
        <span class="top">
          <span class="name" class:unread={u}>{ch.kind === 'hashtag' ? ch.name.slice(1) : ch.name}</span>
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
  {#each dms as d (d.id)}
    {@const k = `dm:${d.id}` as const}
    {@const u = app.unread(k)}
    <button class="row ghost" class:active={app.activeThread === k} onclick={() => app.openThread(k)}>
      <Badge id={d.id} label={d.node?.shortName ?? '?'} size={26} />
      <span class="main">
        <span class="top">
          <span class="name" class:unread={u}>{d.node?.longName ?? d.id}</span>
          <span class="time faint">{ago(d.last?.ts, app.now)}</span>
        </span>
        <span class="preview muted">{preview(k)}</span>
      </span>
      {#if u}<b class="count">{u}</b>{/if}
    </button>
  {:else}
    <p class="faint empty">Open a node and choose “Direct message”.</p>
  {/each}
</aside>

<style>
  aside {
    overflow-y: auto;
    background: var(--panel);
    border-right: 1px solid var(--border);
    padding-bottom: 8px;
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
