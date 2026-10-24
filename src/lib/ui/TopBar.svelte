<script lang="ts">
  import { radioActions } from '../model/capabilities'
  import { app } from '../state.svelte'

  const s = $derived(app.session!)
  const info = $derived(s.info)
  const r = $derived(info.radio)
  const radioSummary = $derived(
    info.protocol === 'meshtastic'
      ? [r.region, r.preset, r.freqMHz && `${r.freqMHz} MHz`].filter(Boolean).join(' · ')
      : [r.freqMHz && `${r.freqMHz} MHz`, r.bwKHz && `BW ${r.bwKHz}`, r.sf && `SF${r.sf}`, r.cr && `CR${r.cr}`]
          .filter(Boolean)
          .join(' · '),
  )
</script>

<header>
  <span class="brand">meshmash</span>
  <span class="proto">{info.protocol === 'meshtastic' ? 'Meshtastic' : 'MeshCore'} {info.firmware}</span>
  <button class="ghost radio" onclick={() => app.showNode(info.nodeId)}>
    <b>{info.longName}</b>
    <span class="mono muted">{info.nodeId}</span>
  </button>
  <span class="muted">{info.hwModel}</span>
  <span class="muted">{radioSummary}</span>
  <span class="spacer"></span>
  {#each radioActions(info.protocol) as a (a.id)}
    <button onclick={() => app.runAction(a.id, info.nodeId)}>{a.label}</button>
  {/each}
  <span class="muted">{app.nodes.length} nodes</span>
  {#if info.batteryPct !== undefined}
    <span class="muted">Batt {info.batteryPct}%{info.voltage ? ` · ${info.voltage.toFixed(2)} V` : ''}</span>
  {/if}
  <span class="conn"><i></i>{s.transport}</span>
  <button onclick={() => app.disconnect()}>Disconnect</button>
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 36px;
    padding: 0 10px 0 14px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    overflow: hidden;
  }
  .brand {
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .proto {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .radio {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 2px 6px;
  }
  .spacer {
    flex: 1;
  }
  .conn {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
  }
  .conn i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--good);
  }
</style>
