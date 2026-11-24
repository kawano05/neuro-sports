<script>
  // 人の印。名前の頭文字の丸ではなく、その人の色のヘルメット（野球の画面のバッターと同じ色）。
  // 見分けるのは色。見るだけの人は灰色。ボッチャでは、チームの色の玉を添える。
  let { color = "#D5D0C4", team = null, size = 36 } = $props();
  const TEAM = { red: "#E0302D", blue: "#1E6FD9" };
</script>

<svg class="mark" width={size} height={size * 0.85} viewBox="0 0 40 34" aria-hidden="true">
  <path d="M8 24 L8 29.5 Q8 32 10.5 32 L16.5 32 L18.5 24 Z" fill={color} stroke="#1A1A1A" stroke-width="2.5" stroke-linejoin="round" />
  <path d="M4 24 A16 16 0 0 1 36 24 Z" fill={color} stroke="#1A1A1A" stroke-width="2.5" stroke-linejoin="round" />
  <path d="M30 21.5 L38.5 21.5 Q40 21.5 40 23 Q40 24.5 38.5 24.5 L30 24.5 Z" fill={color} stroke="#1A1A1A" stroke-width="2.2" stroke-linejoin="round" />
  <path d="M11 15 Q15 9.5 21 8.5" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" opacity="0.55" />
  <circle cx="12.5" cy="27.5" r="1.7" fill="#1A1A1A" />
  {#if team}
    <circle cx="33" cy="29" r="4.6" fill={TEAM[team]} stroke="#1A1A1A" stroke-width="2" />
  {/if}
</svg>

<style>
  .mark {
    flex: none;
    display: block;
    overflow: visible;
  }
</style>
