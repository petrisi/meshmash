<script lang="ts">
  import { app, type View } from '../state.svelte'

  const totalUnread = $derived(
    [...app.channels.map((c) => `ch:${c.index}` as const), ...app.dmPeers.map((id) => `dm:${id}` as const)].reduce(
      (n, k) => n + app.unread(k),
      0,
    ),
  )

  const items: { view: View | null; label: string; icon: string; disabled?: boolean }[] = [
    { view: 'messages', label: 'Messages', icon: 'M3 5h18v11H8l-5 4z' },
    { view: 'nodes', label: 'Nodes', icon: 'M6 6m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M18 8m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M10 18m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M7.5 8l2 7.5M15.6 9.2l-4 6.8M8.4 6.3l7.2 1.4' },
    { view: null, label: 'Map', icon: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14', disabled: true },
    { view: null, label: 'Config', icon: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1', disabled: true },
  ]
</script>

<nav>
  {#each items as it (it.label)}
    <button
      class="ghost"
      class:active={it.view === app.view}
      disabled={it.disabled}
      title={it.disabled ? `${it.label} (later)` : it.label}
      onclick={() => it.view && (app.view = it.view)}
    >
      <svg viewBox="0 0 24 24" width="20" height="20"><path d={it.icon} /></svg>
      <span>{it.label}</span>
      {#if it.view === 'messages' && totalUnread}<b class="dot">{totalUnread}</b>{/if}
    </button>
  {/each}
</nav>

<style>
  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 4px;
    background: var(--panel);
    border-right: 1px solid var(--border);
  }
  button {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 7px 0 5px;
    font-size: 10.5px;
    color: var(--muted);
    border-radius: 6px;
  }
  button.active {
    color: var(--accent);
    background: var(--accent-soft);
  }
  svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .dot {
    position: absolute;
    top: 3px;
    right: 6px;
    min-width: 16px;
    padding: 0 4px;
    border-radius: 8px;
    font-size: 10px;
    line-height: 16px;
    background: var(--accent);
    color: var(--accent-ink);
  }
</style>
