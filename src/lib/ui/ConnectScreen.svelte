<script lang="ts">
  import { app } from '../state.svelte'

  const hasSerial = 'serial' in navigator
</script>

<div class="wrap">
  <div class="card">
    <h1>meshmash</h1>
    <p class="muted">Web client for Meshtastic® and MeshCore radios.</p>

    <button class="primary big" disabled={!hasSerial} title="Protocol layer not implemented yet">
      Connect USB radio
    </button>
    {#if !hasSerial}
      <p class="poor small">This browser has no Web Serial support. Use Chrome, Edge or another Chromium browser.</p>
    {/if}

    <div class="sep"><span>or try a demo</span></div>
    <div class="demos">
      <button onclick={() => app.connectDemo('meshtastic')}>Demo: Meshtastic</button>
      <button onclick={() => app.connectDemo('meshcore')}>Demo: MeshCore</button>
    </div>

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
    width: 380px;
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
