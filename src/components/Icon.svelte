<script>
  // 小さな線の絵。絵文字（⚙ など）は端末ごとに絵が変わるので使わない。
  let { name, size = 24 } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#if name === "gear"}
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.6v2.4M12 19v2.4M21.4 12H19M5 12H2.6M18.6 5.4l-1.7 1.7M7.1 16.9l-1.7 1.7M18.6 18.6l-1.7-1.7M7.1 7.1 5.4 5.4" />
    <circle cx="12" cy="12" r="6.6" />
  {/if}
</svg>
