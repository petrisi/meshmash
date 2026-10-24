<script lang="ts">
  import { hue } from '../format'
  import { app } from '../state.svelte'

  let { id, label, size = 22 }: { id: string; label: string; size?: number } = $props()

  // Fixed width per protocol so columns line up regardless of content (ASCII or emoji).
  const chars = $derived(app.session?.caps.maxShortNameLen ?? 4)
</script>

<span
  class="badge mono"
  style:--h={hue(id)}
  style:width="calc({chars}ch + 10px)"
  style:min-width="{size}px"
  style:height="{size}px"
>{label}</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    overflow: hidden;
    white-space: nowrap;
    border-radius: 4px;
    font-size: 11px;
    line-height: 1;
    font-weight: 600;
    background: hsl(var(--h) 45% 32%);
    color: hsl(var(--h) 80% 88%);
  }
</style>
