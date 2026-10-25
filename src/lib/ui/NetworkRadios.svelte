<script lang="ts">
  import { app } from '../state.svelte'
  import { DEFAULT_BRIDGE, listRadios, loadBridge, type BridgeHello } from '../transport/bridge'

  const GUIDE = 'https://github.com/petrisi/meshmash/blob/main/bridge/README.md'
  const bridge = loadBridge()

  let phase = $state<'idle' | 'busy' | 'done'>('idle')
  let wait = $state<string | null>(null)
  let error = $state<string | null>(null)
  let hello = $state<BridgeHello | null>(null)

  async function find() {
    phase = 'busy'
    error = null
    wait = null
    try {
      hello = await listRadios(bridge, (w) => (wait = w === 'prompt' ? 'Allow local network access in the browser prompt' : 'Waiting for the bridge…'))
      phase = 'done'
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      phase = 'idle'
    }
  }
</script>

<div class="net">
  <p class="faint small">
    WiFi radios are reached through meshmash-bridge, a small program that runs on this computer.
    <a href={GUIDE} target="_blank" rel="noopener noreferrer">Setup instructions</a>
  </p>
  {#if phase === 'done' && hello}
    {#if hello.radios.length}
      {#each hello.radios as r (r.name)}
        <button onclick={() => app.connectBridge(r.name, { takeover: r.inUse })} title={r.inUse ? 'In use by another meshmash window; connecting takes it over' : undefined}>
          <span>{r.name}</span>
          <span class="mono faint">{r.inUse ? 'in use · take over' : r.protocol === 'meshtastic' ? 'Meshtastic' : 'MeshCore'}</span>
        </button>
      {/each}
    {:else}
      <p class="small">The bridge has no radios. Add one: <span class="mono">meshmash-bridge add &lt;name&gt; &lt;address&gt;</span></p>
    {/if}
    <button class="ghost small" onclick={find}>Refresh</button>
  {:else}
    <button onclick={find} disabled={phase === 'busy'}>
      {phase === 'busy' ? (wait ?? 'Looking for the bridge…') : 'Show WiFi radios'}
    </button>
  {/if}
  {#if error}<p class="poor small">{error}</p>{/if}
  {#if bridge.address !== DEFAULT_BRIDGE}<p class="faint small mono">Bridge {bridge.address}</p>{/if}
</div>

<style>
  .net {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  p {
    margin: 0;
  }
  .small {
    font-size: 12px;
  }
  a {
    color: var(--muted);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  a:hover {
    color: var(--text);
  }
  .net > button:not(.ghost) {
    display: flex;
    justify-content: space-between;
  }
  .ghost {
    align-self: flex-start;
  }
</style>
