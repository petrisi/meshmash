<script lang="ts">
  import { MAX_HOPS } from '../../model/hops'

  let {
    value,
    def,
    suggest,
    reason,
    onpick,
  }: {
    /** Hop limit the next message uses. */
    value: number
    /** Radio default. */
    def: number
    suggest?: number
    /** Why `suggest` is offered, e.g. "häli was heard 6 hops away". */
    reason?: string
    onpick: (hops: number) => void
  } = $props()

  let open = $state(false)
  let root: HTMLElement

  function pick(n: number) {
    open = false
    onpick(n)
  }
</script>

<svelte:window
  onclick={(e) => open && !root.contains(e.target as Node) && (open = false)}
  onkeydown={(e) => open && e.key === 'Escape' && (open = false)}
/>

<span class="hp" bind:this={root}>
  {#if suggest !== undefined}
    <button type="button" class="hint" title="{reason}; hop limit {value} may not reach" onclick={() => pick(suggest)}>
      Use {suggest} hops
    </button>
  {/if}
  <button
    type="button"
    class="chip mono"
    class:set={value !== def}
    class:warn={suggest !== undefined}
    title="Hop limit {value}{value === def ? ' (radio default)' : `, radio default ${def}`} · Alt+0…7"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >⤳ {value}</button>
  {#if open}
    <div class="pop" role="dialog" aria-label="Hop limit">
      <div class="row">
        <span class="lbl">Hop limit</span>
        {#each { length: MAX_HOPS + 1 } as _, n (n)}
          <button
            type="button"
            class="n mono"
            class:on={n === value}
            class:def={n === def}
            class:sug={n === suggest}
            title={n === def ? 'Radio default' : n === 0 ? 'Direct neighbours only' : undefined}
            onclick={() => pick(n)}>{n}</button
          >
        {/each}
      </div>
      <p class="faint">
        Radio default {def}{reason ? ` · ${reason}` : ''}<br />
        Kept for this conversation · 0 = direct neighbours only, no delivery receipt
      </p>
    </div>
  {/if}
</span>

<style>
  .hp {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .chip {
    position: relative;
    padding: 5px 9px;
    font-size: 12px;
    color: var(--faint);
  }
  .chip.set {
    color: var(--accent);
    border-color: var(--accent);
  }
  .chip.warn::after {
    content: '';
    position: absolute;
    top: -3px;
    right: -3px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--fair);
  }
  .hint {
    padding: 5px 9px;
    font-size: 12px;
    color: var(--fair);
    border-color: var(--fair);
    white-space: nowrap;
  }
  .pop {
    position: absolute;
    right: 0;
    bottom: calc(100% + 8px);
    z-index: 10;
    padding: 10px 12px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
    white-space: nowrap;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .lbl {
    margin-right: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .n {
    position: relative;
    width: 28px;
    padding: 4px 0;
    text-align: center;
  }
  .n.def::after {
    content: '';
    position: absolute;
    left: 9px;
    right: 9px;
    bottom: 2px;
    border-bottom: 1px solid var(--muted);
  }
  .n.sug {
    border-color: var(--fair);
  }
  .n.on {
    background: var(--accent);
    color: var(--accent-ink);
    border-color: var(--accent);
  }
  p {
    margin: 8px 0 0;
    font-size: 11.5px;
    line-height: 1.5;
  }
</style>
