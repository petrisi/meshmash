<script lang="ts">
  import { NAME_MAX_BYTES, parseKey, randomKey, toBase64, toHex, utf8Length } from '../../model/channels'
  import { hashtagSecret } from '../../protocol/meshcore/codec'
  import { app } from '../../state.svelte'

  type KeyMode = 'keep' | 'aes256' | 'aes128' | 'generate' | 'default' | 'empty' | 'paste'

  // The parent keys this component on the slot, so these are read once.
  const start = app.channelEditor!
  const isMt = app.protocol === 'meshtastic'
  const old = start.isNew ? undefined : app.channelConfig(start.index)
  const shown = app.channels.find((c) => c.index === start.index)
  const maxBytes = NAME_MAX_BYTES[isMt ? 'meshtastic' : 'meshcore']
  const generated = { aes256: randomKey(32), aes128: randomKey(16), generate: randomKey(16) }

  let slot = $state(start.index)
  let name = $state(old?.name ?? (isMt ? '' : '#'))
  let mcType = $state<'hashtag' | 'private'>(start.isNew || shown?.kind === 'hashtag' ? 'hashtag' : 'private')
  let keyMode = $state<KeyMode>(old ? 'keep' : isMt ? 'aes256' : 'generate')
  let pasted = $state('')
  let showKey = $state(false)
  let busy = $state(false)
  let error = $state('')
  let hashKey = $state<Uint8Array | undefined>()
  let confirming = $state(false)

  const hashtag = $derived(!isMt && mcType === 'hashtag')
  const primary = $derived(isMt && slot === 0)
  const trimmed = $derived(name.trim())

  $effect(() => {
    const n = trimmed
    hashKey = undefined
    if (hashtag && n.length > 1 && n.startsWith('#')) void hashtagSecret(n).then((k) => trimmed === n && (hashKey = k))
  })

  const key = $derived.by((): Uint8Array | undefined => {
    if (hashtag) return hashKey
    switch (keyMode) {
      case 'keep':
        return old?.key
      case 'aes256':
      case 'aes128':
      case 'generate':
        return generated[keyMode]
      case 'default':
        return Uint8Array.of(1)
      case 'empty':
        return new Uint8Array()
      case 'paste':
        return parseKey(pasted, isMt ? [1, 16, 32] : [16])
    }
  })

  const nameError = $derived.by(() => {
    if (utf8Length(trimmed) > maxBytes) return `At most ${maxBytes} bytes`
    if (hashtag && (!trimmed.startsWith('#') || trimmed.length < 2)) return 'A hashtag channel name starts with #'
    if (!trimmed && !primary) return 'Name required'
    return ''
  })
  const keyError = $derived(!hashtag && keyMode === 'paste' && pasted.trim() && !key ? (isMt ? '1, 16 or 32 bytes, base64 or hex' : '16 bytes, hex or base64') : '')
  const valid = $derived(!nameError && !!key)
  const next = $derived(key ? { index: slot, name: trimmed, key } : undefined)
  const doomed = $derived(next && app.replacesChannel(next, start.isNew) ? (app.byThread.get(`ch:${slot}`)?.length ?? 0) : 0)
  const keyText = $derived(key?.length ? (isMt ? toBase64(key) : toHex(key)) : '')

  const messageCount = app.byThread.get(`ch:${start.index}`)?.length ?? 0

  async function remove() {
    busy = true
    error = ''
    try {
      await app.deleteChannel(start.index)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      confirming = false
    } finally {
      busy = false
    }
  }

  async function save(e: SubmitEvent) {
    e.preventDefault()
    if (!next) return
    busy = true
    error = ''
    try {
      await app.saveChannel(next, start.isNew)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

<div class="section">
  <span>{start.isNew ? 'New channel' : 'Edit channel'}</span>
  <button class="ghost close" title="Close" onclick={() => (app.channelEditor = null)}>✕</button>
</div>
<form class="form" onsubmit={save}>
  <span class="lbl">Slot</span>
  {#if start.isNew}
    <select bind:value={slot}>
      {#each app.freeChannelSlots as i (i)}<option value={i}>{i}</option>{/each}
    </select>
  {:else}
    <span class="mono">{slot}{primary ? ' · primary' : ''}</span>
  {/if}

  {#if !isMt}
    <span class="lbl">Type</span>
    <span class="seg">
      <button type="button" class:on={mcType === 'hashtag'} onclick={() => (mcType = 'hashtag')}>Hashtag</button>
      <button type="button" class:on={mcType === 'private'} onclick={() => (mcType = 'private')}>Private</button>
    </span>
  {/if}

  <span class="lbl">Name</span>
  <span class="field">
    <!-- svelte-ignore a11y_autofocus -->
    <input bind:value={name} placeholder={primary ? shown?.name : hashtag ? '#name' : ''} autocomplete="off" spellcheck="false" autofocus />
    <span class="faint small count">{utf8Length(trimmed)}/{maxBytes}</span>
  </span>
  {#if nameError && trimmed && trimmed !== '#'}<span></span><span class="err small">{nameError}</span>{/if}

  <span class="lbl">Key</span>
  {#if hashtag}
    <span class="faint">Derived from the name</span>
  {:else}
    <select bind:value={keyMode}>
      {#if old}<option value="keep">Keep current</option>{/if}
      {#if isMt}
        <option value="aes256">Random AES-256</option>
        <option value="aes128">Random AES-128</option>
        <option value="default">Default key (AQ==)</option>
        <option value="empty">{primary ? 'None (no encryption)' : 'Same as primary'}</option>
      {:else}
        <option value="generate">Random</option>
      {/if}
      <option value="paste">Paste</option>
    </select>
    {#if keyMode === 'paste'}
      <span></span>
      <input bind:value={pasted} placeholder={isMt ? 'Base64 or hex' : 'Hex or base64'} autocomplete="off" spellcheck="false" />
    {/if}
    {#if keyError}<span></span><span class="err small">{keyError}</span>{/if}
  {/if}
  {#if keyText}
    <span></span>
    <span class="key">
      <span class="mono text">{showKey ? keyText : '••••••••••••'}</span>
      <button type="button" class="ghost" onclick={() => (showKey = !showKey)}>{showKey ? 'Hide' : 'Show'}</button>
      <button type="button" class="ghost" onclick={() => void navigator.clipboard.writeText(keyText)}>Copy</button>
    </span>
  {/if}

  {#if isMt && start.isNew}
    <span></span><span class="faint small">MQTT uplink and downlink off · Position: exact</span>
  {/if}
  {#if doomed}
    <span></span><span class="muted small">Saving starts a new conversation; {doomed === 1 ? 'the message in this one is deleted' : `the ${doomed} messages in this one are deleted`}.</span>
  {/if}
  {#if error}<span></span><span class="err small">{error}</span>{/if}

  <span></span>
  <span class="buttons">
    <button class="primary" type="submit" disabled={!valid || busy}>{busy ? 'Saving…' : 'Save'}</button>
    <button type="button" onclick={() => (app.channelEditor = null)}>Cancel</button>
  </span>
</form>

{#if app.canDeleteChannel}
  <div class="delete">
    {#if confirming}
      <span class="small">
        Delete {shown?.name ?? `channel ${start.index}`}{messageCount ? ` and its ${messageCount === 1 ? 'message' : `${messageCount} messages`}` : ''}?
      </span>
      <span class="buttons">
        <button class="danger" disabled={busy} onclick={remove}>{busy ? 'Deleting…' : 'Delete'}</button>
        <button disabled={busy} onclick={() => (confirming = false)}>Keep</button>
      </span>
    {:else}
      <button class="ghost danger" disabled={busy} onclick={() => (confirming = true)}>Delete channel</button>
    {/if}
  </div>
{/if}

<style>
  .form {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 6px 10px;
    align-items: center;
    padding: 2px 12px 10px;
  }
  .lbl {
    color: var(--muted);
  }
  .close {
    padding: 0 4px;
    text-transform: none;
  }
  select {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 6px;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .field input {
    flex: 1;
    min-width: 0;
  }
  .count {
    flex: none;
  }
  .key {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }
  .key .text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-right: auto;
  }
  .key button {
    padding: 1px 6px;
  }
  .seg {
    display: inline-flex;
  }
  .seg button {
    border-radius: 0;
    padding: 2px 10px;
  }
  .seg button:first-child {
    border-radius: 4px 0 0 4px;
  }
  .seg button:last-child {
    border-radius: 0 4px 4px 0;
    border-left: none;
  }
  .seg button.on {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .small {
    font-size: 11px;
  }
  .err {
    color: var(--danger);
  }
  .delete {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    margin: 4px 12px 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .delete > button {
    padding-left: 0;
  }
  .buttons {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
</style>
