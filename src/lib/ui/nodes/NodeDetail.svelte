<script lang="ts">
  import { ago, distanceKm, km, snrClass, uptime } from '../../format'
  import { KIND_LABEL, nodeActions } from '../../model/capabilities'
  import type { MeshNode } from '../../model/types'
  import { app } from '../../state.svelte'
  import Badge from '../Badge.svelte'
  import MiniMap, { type MapPoint } from '../MiniMap.svelte'

  let { node, compact = false }: { node: MeshNode; compact?: boolean } = $props()

  const isSelf = $derived(node.id === app.selfId)
  const proto = $derived(app.protocol!)
  const actions = $derived(nodeActions(proto, node, isSelf))
  const self = $derived(app.nodeById.get(app.selfId))
  const dist = $derived(isSelf ? undefined : distanceKm(self?.position, node.position))
  const tr = $derived(app.traceroutes[node.id])
  const busy = $derived(app.busy[node.id])
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
      <div class="mono muted">{node.id}{isSelf ? ' · this radio' : ''}</div>
    </div>
  </div>

  <div class="actions">
    {#each actions as a (a.id)}
      <button
        class:primary={a.primary}
        class:danger={a.danger}
        disabled={!!busy}
        onclick={() => app.runAction(a.id, node.id)}
      >
        {busy === a.id ? `${a.label}…` : a.label}
      </button>
    {/each}
  </div>

  {#if tr}
    <div class="section"><span>Route</span><span class="faint">{ago(tr.ts, app.now)} ago</span></div>
    <div class="route">
      <div class="dir muted">Towards</div>
      <ol>
        {#each tr.towards as id, i (i)}
          <li>
            <span class="hop">{name(id)}</span>
            {#if i > 0}<span class="mono {snrClass(tr.snrTowards[i - 1])}">{tr.snrTowards[i - 1]} dB</span>{/if}
          </li>
        {/each}
      </ol>
      {#if tr.back}
        <div class="dir muted">Back</div>
        <ol>
          {#each tr.back as id, i (i)}
            <li>
              <span class="hop">{name(id)}</span>
              {#if i > 0 && tr.snrBack}<span class="mono {snrClass(tr.snrBack[i - 1])}">{tr.snrBack[i - 1]} dB</span>{/if}
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  {/if}

  <div class="section"><span>Node</span></div>
  <dl class="kv">
    <dt>Type</dt><dd>{KIND_LABEL[node.kind]}</dd>
    <dt>Hardware</dt><dd>{node.hwModel ?? '—'}</dd>
    <dt>Short name</dt><dd class="mono">{node.shortName}</dd>
    {#if node.publicKey}<dt>Public key</dt><dd class="mono" title={node.publicKey}>{node.publicKey}</dd>{/if}
    {#if !isSelf}<dt>Last heard</dt><dd>{ago(node.lastHeard, app.now)} ago</dd>{/if}
    {#if node.uptimeS !== undefined}<dt>Uptime</dt><dd>{uptime(node.uptimeS)}</dd>{/if}
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
      <dt>Battery</dt><dd>{node.batteryPct !== undefined ? `${node.batteryPct}%` : '—'}{node.voltage ? ` · ${node.voltage.toFixed(2)} V` : ''}</dd>
      {#if proto === 'meshtastic'}
        <dt>Channel util</dt><dd>{node.channelUtil !== undefined ? `${node.channelUtil}%` : '—'}</dd>
        <dt>Air util TX</dt><dd>{node.airUtilTx !== undefined ? `${node.airUtilTx}%` : '—'}</dd>
      {/if}
    </dl>

  {/if}

  <div class="section"><span>Position</span></div>
  <dl class="kv">
    {#if node.position}
      {#if !isSelf}
        <dt>Distance</dt>
        <dd>{dist !== undefined ? `${km(dist)} km` : 'unknown (own position not set)'}</dd>
      {/if}
      <dt>Lat / Lon</dt><dd class="mono">{node.position.lat.toFixed(5)}, {node.position.lon.toFixed(5)}</dd>
      {#if node.position.alt !== undefined}<dt>Altitude</dt><dd>{node.position.alt} m</dd>{/if}
    {:else}
      <dt>—</dt><dd class="faint">No position</dd>
    {/if}
  </dl>
  {#if mapPoints.length}<MiniMap points={mapPoints} />{/if}
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
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 12px 6px;
  }
  .route {
    padding: 0 12px 6px;
  }
  .dir {
    font-size: 11px;
    margin-top: 2px;
  }
  ol {
    margin: 2px 0 6px;
    padding-left: 22px;
  }
  li {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  li::marker {
    color: var(--faint);
  }
  .hop {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
