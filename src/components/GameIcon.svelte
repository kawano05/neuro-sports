<script>
  // 遊びを選ぶところの絵。野球は「円盤の上のボール」、ボッチャは「ランプと玉」。
  let { game } = $props();
</script>

{#if game === "baseball"}
  <svg viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="44" fill="#FFB020" stroke="#1A1A1A" stroke-width="5" />
    <g stroke="#C77800" stroke-width="3">
      <line x1="50" y1="14" x2="50" y2="28" />
      <line x1="50" y1="72" x2="50" y2="86" />
      <line x1="14" y1="50" x2="28" y2="50" />
      <line x1="72" y1="50" x2="86" y2="50" />
    </g>
    <circle cx="50" cy="50" r="9" fill="#1A1A1A" />
    <circle cx="50" cy="76" r="15" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="4" />
    <path d="M42 68 Q47 76 42 84 M58 68 Q53 76 58 84" fill="none" stroke="#E0302D" stroke-width="2.6" />
  </svg>
{:else}
  <svg viewBox="0 0 100 100" aria-hidden="true">
    <rect x="6" y="6" width="88" height="88" rx="18" fill="#BFD9EE" stroke="#1A1A1A" stroke-width="5" />
    <circle cx="50" cy="34" r="9" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="4" />
    <circle cx="33" cy="48" r="12" fill="#E0302D" stroke="#1A1A1A" stroke-width="4" />
    <circle cx="66" cy="44" r="12" fill="#1E6FD9" stroke="#1A1A1A" stroke-width="4" />
    <path d="M40 92 L46 62 L56 62 L62 92 Z" fill="#E7B56A" stroke="#1A1A1A" stroke-width="4" stroke-linejoin="round" />
  </svg>
{/if}
