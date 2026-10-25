<script lang="ts">
  import { onMount } from 'svelte'
  import { app } from '../state.svelte'
  import { portNames } from '../transport/portNames'

  const hasSerial = 'serial' in navigator
  let known = $state<SerialPort[]>([])
  let names = $state<(string | undefined)[]>([])

  const label = (p: SerialPort) => {
    const i = p.getInfo()
    const h = (n?: number) => (n ?? 0).toString(16).padStart(4, '0')
    return i.usbVendorId !== undefined ? `USB ${h(i.usbVendorId)}:${h(i.usbProductId)}` : 'Serial port'
  }

  async function refresh() {
    if (!hasSerial) return
    known = await navigator.serial.getPorts()
    names = await portNames(known)
  }

  onMount(() => {
    void refresh()
    if (!hasSerial) return
    navigator.serial.addEventListener('connect', refresh)
    navigator.serial.addEventListener('disconnect', refresh)
    return () => {
      navigator.serial.removeEventListener('connect', refresh)
      navigator.serial.removeEventListener('disconnect', refresh)
    }
  })

  const lastLines = $derived(app.log.slice(-8))
</script>

<div class="wrap">
  <div class="card">
    <h1>meshmash <span class="version mono">v{__APP_VERSION__}</span></h1>
    <p class="muted">Web client for Meshtastic® and MeshCore radios.</p>

    {#if app.reconnecting && !app.connecting}
      <div class="progress">
        <i class="spin"></i>
        <span>Waiting for {app.reconnecting.name}… (attempt {app.reconnecting.attempt})</span>
      </div>
      {#if app.connectError}<p class="poor small">{app.connectError.text}</p>{/if}
      <button onclick={() => app.stopReconnect()}>Stop reconnecting</button>
    {:else if app.connecting}
      <div class="progress">
        <i class="spin"></i>
        <span>{app.reconnecting ? `${app.reconnecting.name}: ` : ''}{app.connecting}</span>
      </div>
      <div class="tail mono">
        {#each lastLines as e, i (i)}
          <div class="faint">{e.dir} {e.kind} {e.summary}</div>
        {/each}
      </div>
      <button onclick={() => app.disconnect()}>Cancel</button>
    {:else}
      <button class="primary big" disabled={!hasSerial} onclick={() => app.connectSerial()}>
        Connect USB radio
      </button>
      {#if known.length}
        <div class="known">
          <span class="faint small">Previously allowed ports</span>
          {#each known as p, i (i)}
            <button onclick={() => app.connectSerial(p)}>
              <span>{names[i] ?? 'Unknown radio'}</span>
              <span class="mono faint">{label(p)}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if !hasSerial}
        <p class="poor small">This browser has no Web Serial support. Use Chrome, Edge or another Chromium browser.</p>
      {/if}
      {#if app.connectError?.via === 'usb'}
        <p class="poor small">{app.connectError.text}</p>
      {/if}

      {#if __BRIDGE__}
        <div class="sep"><span>or over WiFi</span></div>
        {#await import('./NetworkRadios.svelte') then m}<m.default />{/await}
      {/if}

      <div class="sep"><span>or try a demo</span></div>
      <div class="demos">
        <button onclick={() => app.connectDemo('meshtastic')}>Demo: Meshtastic</button>
        <button onclick={() => app.connectDemo('meshcore')}>Demo: MeshCore</button>
      </div>
    {/if}

    <p class="faint small legal">
      Not affiliated with or endorsed by Meshtastic LLC or the MeshCore project. Meshtastic® is a registered
      trademark of Meshtastic LLC.
    </p>
  </div>
</div>

<style>
  .wrap {
    height: 100%;
    display: grid;
    place-items: center;
  }
  .card {
    width: 420px;
    padding: 28px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  h1 {
    margin: 0;
    font-size: 22px;
    letter-spacing: -0.01em;
  }
  .version {
    font-size: 12px;
    font-weight: 400;
    color: var(--faint);
    letter-spacing: 0;
  }
  p {
    margin: 0;
  }
  .big {
    padding: 8px;
    font-size: 14px;
    margin-top: 8px;
  }
  .small {
    font-size: 12px;
  }
  .known {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .known button {
    display: flex;
    justify-content: space-between;
  }
  .progress {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
    font-size: 14px;
  }
  .spin {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--faint);
    border-top-color: var(--accent);
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .tail {
    font-size: 10.5px;
    max-height: 140px;
    overflow: hidden;
    white-space: nowrap;
  }
  .tail div {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sep {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--faint);
    font-size: 12px;
    margin: 6px 0;
  }
  .sep::before,
  .sep::after {
    content: '';
    flex: 1;
    border-top: 1px solid var(--border);
  }
  .demos {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .demos button {
    padding: 6px;
  }
  .legal {
    margin-top: 12px;
  }
</style>
