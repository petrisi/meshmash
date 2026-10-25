<script lang="ts">
  import { app } from './lib/state.svelte'
  import ConnectScreen from './lib/ui/ConnectScreen.svelte'
  import LogView from './lib/ui/LogView.svelte'
  import MapView from './lib/ui/map/MapView.svelte'
  import MessagesView from './lib/ui/messages/MessagesView.svelte'
  import NavRail from './lib/ui/NavRail.svelte'
  import NodesView from './lib/ui/nodes/NodesView.svelte'
  import StatusBar from './lib/ui/StatusBar.svelte'
  import TopBar from './lib/ui/TopBar.svelte'

  $effect(() => {
    document.documentElement.dataset.theme = app.protocol ?? 'neutral'
  })
</script>

{#if app.session && !app.connecting}
  <div class="shell">
    <TopBar />
    <div class="body">
      <NavRail />
      <main>
        {#if app.view === 'messages'}<MessagesView />{:else if app.view === 'nodes'}<NodesView />{:else if app.view === 'map'}<MapView />{:else}<LogView />{/if}
      </main>
    </div>
    <StatusBar />
  </div>
{:else}
  <ConnectScreen />
{/if}

<style>
  .shell {
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100%;
  }
  .body {
    display: grid;
    grid-template-columns: 64px 1fr;
    min-height: 0;
  }
  main {
    min-width: 0;
    min-height: 0;
  }
</style>
