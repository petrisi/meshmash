<script lang="ts">
  import { app } from '../../state.svelte'
  import NodeDetail from '../nodes/NodeDetail.svelte'
  import Conversation from './Conversation.svelte'
  import ThreadList from './ThreadList.svelte'

  const thread = $derived(app.activeThread)
  const peer = $derived(thread?.startsWith('dm:') ? app.nodeById.get(thread.slice(3)) : undefined)
  const channel = $derived(
    thread?.startsWith('ch:') ? app.channels.find((c) => `ch:${c.index}` === thread) : undefined,
  )

  // Senders heard on the active channel, most recent first.
  const participants = $derived.by(() => {
    if (!channel || !thread) return []
    const seen = new Map<string, number>()
    for (const m of app.byThread.get(thread) ?? []) if (m.from !== app.selfId) seen.set(m.from, m.ts)
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => app.nodeById.get(id)).filter((n) => !!n)
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
      <div class="section"><span>Heard in channel</span><span class="faint">{participants.length}</span></div>
      <div class="people">
        {#each participants as n (n.id)}
          <button class="ghost person" onclick={() => app.showNode(n.id)}>
            <span class="mono sn">{n.shortName}</span>
            <span class="pn">{n.longName}</span>
          </button>
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
    gap: 8px;
    width: 100%;
    padding: 2px 6px;
    border: none;
    text-align: left;
  }
  .sn {
    width: 40px;
    color: var(--muted);
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
