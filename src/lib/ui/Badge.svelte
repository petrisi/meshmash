<script lang="ts">
  import { hue } from '../format'

  let { id, label, size = 22 }: { id: string; label: string; size?: number } = $props()
</script>

<span
  class="badge mono"
  style:--h={hue(id)}
  style:width="{Math.max(size, label.length * 7.5 + 8)}px"
  style:height="{size}px"
>{label}</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    background: hsl(var(--h) 45% 32%);
    color: hsl(var(--h) 80% 88%);
  }
</style>
