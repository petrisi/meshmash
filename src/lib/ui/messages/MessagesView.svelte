<script lang="ts">
  import { flip } from 'svelte/animate'
  import { ago, distanceErrKm, distanceKm, km } from '../../format'
  import { app } from '../../state.svelte'
  import NodeDetail from '../nodes/NodeDetail.svelte'
  import Conversation from './Conversation.svelte'
  import ThreadList from './ThreadList.svelte'

  const thread = $derived(app.activeThread)
  const peer = $derived(thread?.startsWith('dm:') ? app.nodeById.get(thread.slice(3)) : undefined)
  const channel = $derived(
    thread?.startsWith('ch:') ? app.channels.find((c) => `ch:${c.index}` === thread) : undefined,
  )

  let heardSort = $state<'recent' | 'alpha'>('recent')

  // Freeze order while hovering so entries don't move under the cursor.
  let hovering = $state(false)
  let snapshot: { key: string; ids: string[] } | null = null
  const shown = $derived.by(() => {
    const key = `${thread}|${heardSort}`
    if (!hovering || !snapshot || snapshot.key !== key) {
      snapshot = { key, ids: participants.map((p) => p.node.id) }
      return participants
    }
    const byId = new Map(participants.map((p) => [p.node.id, p]))
    return snapshot.ids.flatMap((id) => byId.get(id) ?? [])
  })

  const selfPos = $derived(app.nodeById.get(app.selfId)?.position)

  // Nodes heard on the active channel with the time they were last heard there.
  const participants = $derived.by(() => {
    if (!channel || !thread) return []
    const heard = app.channelHeard[thread] ?? {}
    const list = Object.entries(heard).flatMap(([id, ts]) => {
      const node = app.nodeById.get(id)
      return node && !node.ignored ? [{ node, ts, dist: distanceKm(selfPos, node.position), err: distanceErrKm(selfPos, node.position) }] : []
    })
    return heardSort === 'alpha'
      ? list.sort((a, b) => a.node.longName.localeCompare(b.node.longName, undefined, { sensitivity: 'base' }))
      : list.sort((a, b) => b.ts - a.ts)
  })
</script>

<div class="grid">
  <ThreadList />
  {#if thread}
    {#key thread}<Conversation {thread} />{/key}
  {:else}
    <div class="empty faint">Select a channel or conversation</div>
  {/if}
  <aside>
    {#if peer}
      <NodeDetail node={peer} compact />
      <div class="foot">
        <button class="ghost" onclick={() => app.showNode(peer.id)}>Open in Nodes →</button>
        <button class="ghost" onclick={() => app.closeDm(peer.id)}>Close conversation</button>
      </div>
    {:else if channel}
      <div class="section"><span>Channel</span></div>
      <dl class="kv">
        <dt>Name</dt><dd>{channel.name}</dd>
        <dt>Index</dt><dd>{channel.index}</dd>
        <dt>Type</dt><dd>{channel.kind}</dd>
        <dt>Encryption</dt><dd>{channel.encryption}</dd>
        <dt>Notifications</dt><dd>{channel.muted ? 'muted' : 'on'}</dd>
      </dl>
      <div class="section">
        <span>Heard in channel <span class="faint">{participants.length}</span></span>
        <span class="seg">
          <button class:on={heardSort === 'recent'} onclick={() => (heardSort = 'recent')}>Last heard</button>
          <button class:on={heardSort === 'alpha'} onclick={() => (heardSort = 'alpha')}>A–Z</button>
        </span>
      </div>
      <div class="people" role="list" onmouseenter={() => (hovering = true)} onmouseleave={() => (hovering = false)}>
        {#each shown as p (p.node.id)}
          <div animate:flip={{ duration: 300 }}>
            {#key p.ts}
              <button
                class="ghost person"
                class:heard-flash={Date.now() - p.ts < 1500}
                onclick={() => app.showNode(p.node.id)}
              >
                <span class="mono sn">{p.node.shortName}</span>
                <span class="pn">{p.node.longName}</span>
                <span class="mono km" title="distance km">{p.dist !== undefined ? km(p.dist, p.err) : ''}</span>
                <span class="mono ago" title="last heard">{ago(p.ts, app.now)}</span>
              </button>
            {/key}
          </div>
        {/each}
      </div>
    {/if}
  </aside>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: 300px 1fr 320px;
    height: 100%;
    min-height: 0;
  }
  .grid > :global(*) {
    min-height: 0;
  }
  aside {
    overflow-y: auto;
    background: var(--panel);
    border-left: 1px solid var(--border);
  }
  .empty {
    display: grid;
    place-items: center;
  }
  .foot {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 0 6px;
  }
  .people {
    padding: 0 6px 8px;
  }
  .person {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 2px 6px;
    border: none;
    text-align: left;
  }
  .sn {
    flex: none;
    width: calc(4ch + 4px);
    overflow: hidden;
    white-space: nowrap;
    color: var(--muted);
  }
  .km {
    margin-left: auto;
    flex: none;
    width: 4ch;
    text-align: right;
    color: var(--muted);
  }
  .ago {
    flex: none;
    width: 4ch;
    text-align: right;
    color: var(--faint);
  }
  .seg {
    display: inline-flex;
    text-transform: none;
    letter-spacing: 0;
  }
  .seg button {
    padding: 0 7px;
    font-size: 11px;
    border-radius: 0;
  }
  .seg button:first-child {
    border-radius: 4px 0 0 4px;
  }
  .seg button:last-child {
    border-radius: 0 4px 4px 0;
    border-left: none;
  }
  .seg button.on {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .pn {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-width: 1280px) {
    .grid {
      grid-template-columns: 260px 1fr;
    }
    aside {
      display: none;
    }
  }
</style>
