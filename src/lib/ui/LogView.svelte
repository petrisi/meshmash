<script lang="ts">
  import { tick } from 'svelte'
  import { hex } from '../protocol/bytes'
  import type { LogDir } from '../protocol/types'
  import { app } from '../state.svelte'

  let filter = $state('')
  let dirs = $state<Record<LogDir, boolean>>({ rx: true, tx: true, text: true, info: true, error: true })
  let follow = $state(true)
  let open = $state<number | null>(null)
  let scroller: HTMLDivElement

  /** Rendering is capped; the full log stays available to Copy. */
  const SHOW = 1500

  const matches = $derived.by(() => {
    const q = filter.trim().toLowerCase()
    const out: { i: number; e: (typeof app.log)[number] }[] = []
    app.log.forEach((e, i) => {
      if (!dirs[e.dir]) return
      if (q && !`${e.kind} ${e.summary}`.toLowerCase().includes(q)) return
      out.push({ i, e })
    })
    return out
  })
  const rows = $derived(matches.slice(-SHOW))

  const time = (ts: number) => {
    const d = new Date(ts)
    return `${d.toLocaleTimeString([], { hourCycle: 'h23' })}.${String(d.getMilliseconds()).padStart(3, '0')}`
  }

  const ARROW: Record<LogDir, string> = { rx: '←', tx: '→', text: '·', info: 'i', error: '!' }

  $effect(() => {
    void rows.length
    if (follow) tick().then(() => scroller && (scroller.scrollTop = scroller.scrollHeight))
  })

  function hexdump(b: Uint8Array) {
    const lines: string[] = []
    for (let o = 0; o < b.length; o += 16) {
      const chunk = b.subarray(o, o + 16)
      const h = hex(chunk).replace(/(..)/g, '$1 ').padEnd(48)
      const a = Array.from(chunk, (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('')
      lines.push(`${o.toString(16).padStart(4, '0')}  ${h} ${a}`)
    }
    return lines.join('\n')
  }

  function copy() {
    const text = matches
      .map(({ e }) => `${time(e.ts)} ${e.dir} ${e.kind} ${e.summary}${e.bytes ? ` [${hex(e.bytes)}]` : ''}`)
      .join('\n')
    void navigator.clipboard.writeText(text)
  }
</script>

<section>
  <div class="toolbar">
    <input placeholder="Filter" bind:value={filter} />
    {#each Object.keys(dirs) as d (d)}
      <label><input type="checkbox" bind:checked={dirs[d as LogDir]} /> {d}</label>
    {/each}
    <label><input type="checkbox" bind:checked={follow} /> follow</label>
    <span class="spacer"></span>
    <span class="faint">{matches.length} / {app.log.length}{matches.length > SHOW ? ` (last ${SHOW} shown)` : ''}</span>
    <button onclick={copy}>Copy</button>
  </div>
  <div class="scroll mono" bind:this={scroller}>
    {#each rows as { i, e } (i)}
      <button class="row ghost {e.dir}" class:open={open === i} onclick={() => (open = open === i ? null : i)}>
        <span class="t faint">{time(e.ts)}</span>
        <span class="d">{ARROW[e.dir]}</span>
        <span class="k">{e.kind}</span>
        <span class="s">{e.summary}</span>
        <span class="n faint">{e.bytes ? `${e.bytes.length} B` : ''}</span>
      </button>
      {#if open === i && e.bytes}
        <pre>{hexdump(e.bytes)}</pre>
      {/if}
    {/each}
  </div>
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .toolbar input:not([type]) {
    width: 240px;
  }
  label {
    display: flex;
    gap: 4px;
    align-items: center;
    color: var(--muted);
  }
  .spacer {
    flex: 1;
  }
  .scroll {
    flex: 1;
    overflow: auto;
    font-size: 11.5px;
  }
  .row {
    display: grid;
    grid-template-columns: 96px 14px 230px 1fr 52px;
    gap: 8px;
    width: 100%;
    padding: 1px 10px;
    border: none;
    border-radius: 0;
    text-align: left;
    white-space: nowrap;
  }
  .row:hover,
  .row.open {
    background: var(--panel);
  }
  .k,
  .s {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rx .d {
    color: var(--good);
  }
  .tx .d {
    color: var(--accent);
  }
  .text {
    color: var(--muted);
  }
  .info .k {
    color: var(--fair);
  }
  .error {
    color: var(--danger);
  }
  .n {
    text-align: right;
  }
  pre {
    margin: 0;
    padding: 4px 10px 8px 128px;
    font-size: 11px;
    color: var(--muted);
    background: var(--panel);
  }
</style>
