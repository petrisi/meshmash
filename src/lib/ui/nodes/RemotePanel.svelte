<script lang="ts">
  import { ago } from '../../format'
  import type { MeshNode } from '../../model/types'
  import { app } from '../../state.svelte'

  let { node, loginOpen = $bindable(false) }: { node: MeshNode; loginOpen?: boolean } = $props()

  const r = $derived(app.remote[node.id] ?? {})
  const isServer = $derived(node.kind === 'repeater' || node.kind === 'room' || node.kind === 'sensor')
  const admin = $derived(r.login?.role === 'admin')
  const name = (id: string) => app.nodeById.get(id)?.longName ?? id

  let password = $state('')
  let cmd = $state('')
  let cliBox: HTMLDivElement | undefined = $state()

  function login(e: SubmitEvent) {
    e.preventDefault()
    app.login(node.id, password)
    password = ''
    loginOpen = false
  }

  function sendCli(e: SubmitEvent) {
    e.preventDefault()
    if (!cmd.trim()) return
    app.cli(node.id, cmd.trim())
    cmd = ''
  }

  $effect(() => {
    void r.cli?.length
    if (cliBox) cliBox.scrollTop = cliBox.scrollHeight
  })
</script>

{#if loginOpen}
  <form class="login" onsubmit={login}>
    <!-- svelte-ignore a11y_autofocus -->
    <input type="password" placeholder="Password (empty = guest)" bind:value={password} autocomplete="off" autofocus />
    <button class="primary" type="submit">Log in</button>
    <button type="button" onclick={() => (loginOpen = false)}>Cancel</button>
  </form>
{/if}

{#if isServer && r.login}
  <div class="section"><span>Session</span><span class="faint">{ago(r.login.ts, app.now)} ago</span></div>
  <dl class="kv">
    <dt>Logged in as</dt><dd>{r.login.role}</dd>
  </dl>
{/if}

{#if r.status}
  <div class="section"><span>Status</span><span class="faint">{ago(r.status.ts, app.now)} ago</span></div>
  <dl class="kv">
    {#each r.status.fields as f (f.label)}<dt>{f.label}</dt><dd>{f.value}</dd>{/each}
  </dl>
{/if}

{#if r.telemetry}
  <div class="section"><span>Sensors</span><span class="faint">{ago(r.telemetry.ts, app.now)} ago</span></div>
  {#if r.telemetry.readings.length}
    <dl class="kv">
      {#each r.telemetry.readings as t, i (i)}<dt>{t.name} <span class="faint">ch{t.channel}</span></dt><dd>{t.value}</dd>{/each}
    </dl>
  {:else}
    <p class="faint pad">No readings</p>
  {/if}
{/if}

{#if r.neighbours}
  <div class="section">
    <span>Neighbours {r.neighbours.total}</span><span class="faint">{ago(r.neighbours.ts, app.now)} ago</span>
  </div>
  <table class="nb">
    <tbody>
      {#each r.neighbours.list as n (n.id)}
        <tr>
          <td class="nm"><button class="link" onclick={() => app.nodeById.has(n.id) && app.showNode(n.id)}>{name(n.id)}</button></td>
          <td class="mono">{n.snr} dB</td>
          <td class="faint">{ago(Date.now() - n.heardSecsAgo * 1000, Date.now())}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if r.owner}
  <div class="section"><span>Owner info</span><span class="faint">{ago(r.owner.ts, app.now)} ago</span></div>
  <pre class="owner">{r.owner.text}</pre>
{/if}

{#if admin}
  <div class="section"><span>Console</span><span class="faint">admin</span></div>
  <div class="cli mono" bind:this={cliBox}>
    {#each r.cli ?? [] as l, i (i)}
      <div class={l.dir}>{l.dir === 'out' ? '> ' : ''}{l.text}</div>
    {:else}
      <div class="faint">Commands run on the node, e.g. "ver", "get name", "neighbors".</div>
    {/each}
  </div>
  <form class="cmd" onsubmit={sendCli}>
    <input class="mono" placeholder="CLI command" bind:value={cmd} />
    <button type="submit">Send</button>
  </form>
{/if}

<style>
  .login,
  .cmd {
    display: flex;
    gap: 6px;
    padding: 0 12px 8px;
  }
  .login input,
  .cmd input {
    flex: 1;
    min-width: 0;
  }
  .pad {
    padding: 0 12px;
    margin: 0;
  }
  .nb {
    width: calc(100% - 24px);
    margin: 0 12px 6px;
    border-collapse: collapse;
    font-size: 12px;
  }
  .nb td {
    padding: 1px 4px 1px 0;
    white-space: nowrap;
  }
  .nb .nm {
    width: 100%;
    max-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .link {
    all: unset;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .owner {
    margin: 0 12px 6px;
    font-size: 12px;
    white-space: pre-wrap;
  }
  .cli {
    margin: 0 12px 6px;
    padding: 6px;
    height: 160px;
    overflow-y: auto;
    font-size: 11.5px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    white-space: pre-wrap;
  }
  .cli .out {
    color: var(--accent);
  }
</style>
