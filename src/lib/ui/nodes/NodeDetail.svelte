<script lang="ts">
  import { ago, battery, distanceErrKm, distanceKm, km, snrClass, uptime } from '../../format'
  import { KIND_LABEL, nodeActions } from '../../model/capabilities'
  import type { MeshNode } from '../../model/types'
  import { app } from '../../state.svelte'
  import Badge from '../Badge.svelte'
  import MiniMap, { type MapPoint } from '../MiniMap.svelte'
  import RemotePanel from './RemotePanel.svelte'
  import RouteView from './RouteView.svelte'
  import TelemetryHistory from './TelemetryHistory.svelte'
  import ContactSettingsPanel from './ContactSettingsPanel.svelte'
  import HopLimitSetting from './HopLimitSetting.svelte'
  import { contactLink } from '../../protocol/meshcore/links'
  import { precisionRadiusM } from '../../map/geo'

  const precision = (bits: number | undefined) => {
    const r = precisionRadiusM(bits)
    return r >= 1000 ? `${(r / 1000).toFixed(1)} km` : `${Math.round(r)} m`
  }

  let { node, compact = false }: { node: MeshNode; compact?: boolean } = $props()

  const isSelf = $derived(node.id === app.selfId)
  const proto = $derived(app.protocol!)
  const actions = $derived(nodeActions(proto, node, isSelf))
  const self = $derived(app.nodeById.get(app.selfId))
  const dist = $derived(isSelf ? undefined : distanceKm(self?.position, node.position))
  const distErr = $derived(distanceErrKm(self?.position, node.position))
  const busy = $derived(app.busy[node.id])
  const results = $derived(
    Object.values(app.results[node.id] ?? {})
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 4),
  )
  let copied = $state(false)
  const LINK_TYPE: Partial<Record<string, number>> = { chat: 1, repeater: 2, room: 3, sensor: 4 }
  async function copyLink() {
    await navigator.clipboard.writeText(
      contactLink({ name: node.longName, publicKey: node.publicKey!, type: LINK_TYPE[node.kind] ?? 1 }),
    )
    copied = true
    setTimeout(() => (copied = false), 1500)
  }
  let loginOpen = $state(false)
  $effect(() => {
    void node.id
    loginOpen = false
  })
  const run = (id: string) => (id === 'login' ? (loginOpen = !loginOpen) : app.runAction(id, node.id))
  const label = (id: string) => actions.find((a) => a.id === id)?.label ?? id
  const mapPoints = $derived.by(() => {
    if (!node.position) return []
    const pts: MapPoint[] = [{ pos: node.position, label: node.shortName }]
    if (!isSelf && self?.position) pts.unshift({ pos: self.position, label: 'You', self: true })
    return pts
  })
  const name = (id: string) => (id === app.selfId ? 'You' : (app.nodeById.get(id)?.longName ?? id))
</script>

<div class="detail">
  <div class="head">
    <Badge id={node.id} label={node.shortName} size={40} />
    <div class="titles">
      <div class="ln">
        {node.longName}
        {#if node.favorite}<span class="star" title="Favorite">★</span>{/if}
        {#if node.ignored}<span class="ign">IGNORED</span>{/if}
      </div>
      <div class="mono muted">
        {node.id}{isSelf ? ' · this radio' : ''}{node.unsaved ? ' · not saved' : ''}
        {#if proto === 'meshcore' && node.publicKey}
          <button class="ghost link" title="Copy a meshcore://contact/add link for sharing" onclick={copyLink}>{copied ? 'copied' : 'copy link'}</button>
        {/if}
      </div>
    </div>
  </div>

  <div class="actions">
    {#each actions as a (a.id)}
      <button
        class:primary={a.primary}
        class:danger={a.danger}
        title={a.title}
        disabled={!!busy}
        onclick={() => run(a.id)}
      >
        {busy === a.id ? `${a.label}…` : a.label}
      </button>
    {/each}
  </div>

  {#if results.length}
    <ul class="results">
      {#each results as r (r.action)}
        <li class={r.state}>
          <span class="mark">{r.state === 'pending' ? '…' : r.state === 'ok' ? '✓' : '✕'}</span>
          <span class="what">{label(r.action)}</span>
          <span class="txt">{r.state === 'pending' ? 'waiting for answer' : r.text}</span>
          <span class="faint when">{ago(r.ts, app.now)}</span>
        </li>
      {/each}
    </ul>
  {/if}

  <RemotePanel {node} bind:loginOpen />
  {#if isSelf && !compact && app.canManageContacts}<ContactSettingsPanel />{/if}

  <RouteView nodeId={node.id} />

  <div class="section"><span>Node</span></div>
  <dl class="kv">
    <dt>Type</dt><dd>{KIND_LABEL[node.kind]}</dd>
    <dt>Hardware</dt><dd>{node.hwModel ?? '—'}</dd>
    <dt>Short name</dt><dd class="mono">{node.shortName}</dd>
    {#if node.publicKey}<dt>Public key</dt><dd class="mono" title={node.publicKey}>{node.publicKey}</dd>{/if}
    {#if !isSelf}<dt>Last heard</dt><dd>{ago(node.lastHeard, app.now)} ago</dd>{/if}
    {#if node.uptimeS !== undefined}<dt>Uptime</dt><dd>{uptime(node.uptimeS)}</dd>{/if}
    {#if isSelf && app.canSetHopLimit}<HopLimitSetting />{/if}
  </dl>

  {#if !isSelf}
    <div class="section"><span>Link</span></div>
    <dl class="kv">
      <dt>Hops</dt><dd>{node.hops ?? '—'}{node.hops === 0 ? ' (direct)' : ''}</dd>
      {#if proto === 'meshcore'}
        <dt>Path</dt>
        <dd class="mono">{node.path === undefined ? 'flood' : node.path.length ? node.path.join(' → ') : 'direct'}</dd>
      {/if}
      <dt>SNR</dt><dd class={snrClass(node.snr)}>{node.snr !== undefined ? `${node.snr} dB` : '—'}</dd>
      <dt>RSSI</dt><dd>{node.rssi !== undefined ? `${node.rssi} dBm` : '—'}</dd>
    </dl>
  {/if}

  {#if !compact}
    <div class="section"><span>Telemetry</span></div>
    <dl class="kv">
      <dt>Battery</dt><dd>{battery(node.batteryPct) || '—'}{node.voltage ? ` · ${node.voltage.toFixed(2)} V` : ''}</dd>
      {#if proto === 'meshtastic'}
        <dt>Channel util</dt><dd>{node.channelUtil !== undefined ? `${node.channelUtil}%` : '—'}</dd>
        <dt>Air util TX</dt><dd>{node.airUtilTx !== undefined ? `${node.airUtilTx}%` : '—'}</dd>
      {/if}
    </dl>

  {/if}

  {#if !compact}<TelemetryHistory nodeId={node.id} />{/if}

  <div class="section">
    <span>Position</span>
    {#if node.position && app.view !== 'map'}<button class="ghost link" onclick={() => app.showOnMap(node.id)}>show on map</button>{/if}
  </div>
  <dl class="kv">
    {#if node.position}
      {#if !isSelf}
        <dt>Distance</dt>
        <dd>{dist !== undefined ? `${km(dist, distErr)} km${km(dist, distErr).startsWith('~') ? ` (±${km(distErr)} km)` : ''}` : 'unknown (own position not set)'}</dd>
      {/if}
      <dt>Lat / Lon</dt><dd class="mono">{node.position.lat.toFixed(5)}, {node.position.lon.toFixed(5)}</dd>
      {#if node.position.alt !== undefined}<dt>Altitude</dt><dd>{node.position.alt} m</dd>{/if}
      {#if precisionRadiusM(node.position.precisionBits)}
        <dt>Precision</dt><dd>within {precision(node.position.precisionBits)} (shared coarsely)</dd>
      {/if}
    {:else}
      <dt>—</dt><dd class="faint">No position</dd>
    {/if}
  </dl>
  {#if mapPoints.length && app.view !== 'map'}<MiniMap points={mapPoints} />{/if}
</div>

<style>
  .detail {
    padding-bottom: 12px;
  }
  .head {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 14px 12px 10px;
  }
  .titles {
    min-width: 0;
  }
  .ln {
    font-size: 16px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .star {
    color: var(--fair);
    font-size: 13px;
  }
  .ign {
    margin-left: 6px;
    font-size: 10px;
    font-weight: 700;
    padding: 0 5px;
    border-radius: 3px;
    background: var(--danger);
    color: var(--bg);
    vertical-align: middle;
  }
  .link {
    padding: 0 4px;
    border: none;
    font-size: 11px;
    color: var(--accent);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 12px 6px;
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 2px 12px 6px;
    font-size: 12px;
  }
  .results li {
    display: grid;
    grid-template-columns: 14px max-content 1fr max-content;
    gap: 6px;
    line-height: 1.6;
  }
  .results .what {
    color: var(--muted);
  }
  .results .txt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .results .ok .mark {
    color: var(--good);
  }
  .results .failed .mark,
  .results .failed .txt {
    color: var(--danger);
  }
  .results .pending .mark {
    color: var(--accent);
  }
</style>
