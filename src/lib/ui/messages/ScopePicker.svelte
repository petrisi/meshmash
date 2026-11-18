<script lang="ts">
  import { scopeName } from '../../model/scope'
  import type { ScopeChoice } from '../../store/floodScopes'

  let {
    value,
    radioDefault,
    canUnscoped,
    known,
    onpick,
  }: {
    /** The channel's choice; undefined for the radio default. */
    value: ScopeChoice | undefined
    /** The radio's default scope: a name, null for none, undefined when not known. */
    radioDefault: string | null | undefined
    canUnscoped: boolean
    /** Names to suggest. */
    known: string[]
    onpick: (scope: ScopeChoice | undefined) => void
  } = $props()

  let open = $state(false)
  let root: HTMLElement
  let draft = $state('')
  const typed = $derived(scopeName(draft))

  const defLabel = $derived(radioDefault === undefined ? 'radio default' : radioDefault === null ? 'none' : radioDefault)
  /** What the next message uses. */
  const shown = $derived(value === undefined ? defLabel : value === null ? 'none' : value)

  function toggle() {
    open = !open
    if (open) draft = typeof value === 'string' ? value : ''
  }
  function pick(s: ScopeChoice | undefined) {
    open = false
    onpick(s)
  }
</script>

<svelte:window
  onclick={(e) => open && !root.contains(e.target as Node) && (open = false)}
  onkeydown={(e) => open && e.key === 'Escape' && (open = false)}
/>

<span class="sp" bind:this={root}>
  <button
    type="button"
    class="chip mono"
    class:set={value !== undefined}
    title="Flood scope {shown}{value === undefined ? ' (radio default)' : ''}"
    aria-expanded={open}
    onclick={toggle}>⌖ {shown}</button
  >
  {#if open}
    <div class="pop" role="dialog" aria-label="Flood scope">
      <div class="lbl">Flood scope for this channel</div>
      <button type="button" class="opt" class:on={value === undefined} onclick={() => pick(undefined)}>
        Radio default <span class="faint">({defLabel})</span>
      </button>
      {#if canUnscoped}
        <button type="button" class="opt" class:on={value === null} onclick={() => pick(null)}>None (unscoped)</button>
      {/if}
      <div class="row">
        <input
          class="mono"
          bind:value={draft}
          placeholder="Region, e.g. fi"
          list="scope-names"
          autocomplete="off"
          onkeydown={(e) => e.key === 'Enter' && typed && pick(typed)}
        />
        <datalist id="scope-names">
          {#each known as n (n)}<option value={n}></option>{/each}
        </datalist>
        <button type="button" disabled={!typed} onclick={() => typed && pick(typed)}>Use</button>
      </div>
      {#if draft.trim() && !typed}<p class="bad">Not a region name: letters, digits and - only, up to 30 bytes</p>{/if}
      <p class="faint">
        Repeaters pass a scoped message on only if they have its region;<br />
        with a region they lack, it goes no further. Names are case-sensitive.
      </p>
    </div>
  {/if}
</span>

<style>
  .sp {
    position: relative;
    display: flex;
    align-items: center;
  }
  .chip {
    padding: 5px 9px;
    font-size: 12px;
    color: var(--faint);
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip.set {
    color: var(--accent);
    border-color: var(--accent);
  }
  .pop {
    position: absolute;
    right: 0;
    bottom: calc(100% + 8px);
    z-index: 10;
    display: grid;
    gap: 4px;
    padding: 10px 12px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
    white-space: nowrap;
  }
  .lbl {
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 2px;
  }
  .opt {
    text-align: left;
    padding: 4px 8px;
  }
  .opt.on {
    background: var(--accent);
    color: var(--accent-ink);
    border-color: var(--accent);
  }
  .opt.on .faint {
    color: inherit;
  }
  .row {
    display: flex;
    gap: 4px;
  }
  .row input {
    flex: 1;
    min-width: 0;
  }
  p {
    margin: 4px 0 0;
    font-size: 11.5px;
    line-height: 1.5;
  }
  .bad {
    color: var(--danger);
  }
</style>
