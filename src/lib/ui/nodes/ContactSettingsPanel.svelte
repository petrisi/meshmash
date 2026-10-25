<script lang="ts">
  import { onMount } from 'svelte'
  import type { ContactSettings } from '../../model/types'
  import { app } from '../../state.svelte'

  let s = $state<ContactSettings | null>(null)
  let saved = $state<string>('')
  let status = $state<'idle' | 'saving' | 'saved' | 'error'>('idle')
  let error = $state('')
  const dirty = $derived(!!s && JSON.stringify(s) !== saved)

  onMount(async () => {
    try {
      s = await app.getContactSettings()
      saved = JSON.stringify(s)
    } catch (e) {
      error = String(e)
    }
  })

  async function save() {
    if (!s) return
    status = 'saving'
    try {
      await app.setContactSettings($state.snapshot(s))
      saved = JSON.stringify(s)
      status = 'saved'
    } catch (e) {
      status = 'error'
      error = e instanceof Error ? e.message : String(e)
    }
  }

  const TYPES = [
    ['chat', 'Companions'],
    ['repeater', 'Repeaters'],
    ['room', 'Room servers'],
    ['sensor', 'Sensors'],
  ] as const
</script>

<div class="section"><span>Contacts</span><span class="faint">stored on the radio</span></div>
{#if s}
  <div class="form">
    <label><input type="checkbox" checked={!s.manual} onchange={(e) => (s!.manual = !e.currentTarget.checked)} /> Add every node heard</label>
    {#if s.manual}
      <div class="types">
        <span class="faint">Add automatically:</span>
        {#each TYPES as [k, label] (k)}
          <label><input type="checkbox" bind:checked={s[k]} /> {label}</label>
        {/each}
      </div>
      <p class="faint hint">Others show up as "not saved" with an Add contact button.</p>
    {/if}
    <label>
      Only nodes up to
      <select bind:value={s.maxHops}>
        <option value={0}>any distance</option>
        <option value={1}>direct only</option>
        {#each [2, 3, 4, 5, 6, 8] as n (n)}<option value={n}>{n - 1} hop{n - 1 === 1 ? '' : 's'}</option>{/each}
      </select>
    </label>
    <label><input type="checkbox" bind:checked={s.overwriteOldest} /> When full, replace the oldest non-favourite contact</label>
    <div class="row">
      <button class="primary" disabled={!dirty || status === 'saving'} onclick={save}>Save</button>
      {#if status === 'saved' && !dirty}<span class="good">Saved to radio</span>{/if}
      {#if status === 'error'}<span class="poor">{error}</span>{/if}
    </div>
  </div>
{:else if error}
  <p class="poor pad">{error}</p>
{:else}
  <p class="faint pad">Loading…</p>
{/if}

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 12px 8px;
    font-size: 12.5px;
  }
  .types {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    padding-left: 20px;
  }
  .hint {
    margin: 0;
    padding-left: 20px;
    font-size: 11.5px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pad {
    padding: 0 12px;
    margin: 0;
  }
</style>
