<script>
  // ホストだけ: 番号だけで来た人の「入りたい」。リンクの合言葉を持たない人は、ここで許可するまで入れない
  // （番号は総当たりで見つけられるため）。来たら小さく音を鳴らして知らせる。
  import { session, audio } from "../lib/app.js";
  import { rb } from "../lib/text.js";

  const pending = $derived($session.pending || []);
  let seen = 0;
  $effect(() => {
    if (pending.length > seen) audio.chime(880, 0, 0.7);
    seen = pending.length;
  });
</script>

{#if pending.length}
  <section class="requests" aria-label="はいりたい人">
    {#each pending as p (p.key)}
      <div class="request" role="alert">
        <span class="who">{@html rb(`${p.name}さんが 入[はい]りたい`)}</span>
        <button class="btn small primary" type="button" onclick={() => session.admitPending(p.key)}>{@html rb("入[い]れる")}</button>
        <button class="btn small" type="button" onclick={() => session.denyPending(p.key)}>{@html rb("ことわる")}</button>
      </div>
    {/each}
  </section>
{/if}

<style>
  .requests {
    display: grid;
    gap: 8px;
  }
  .request {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 8px 12px;
    border-left: 6px solid var(--turn);
    border-radius: 10px;
    background: var(--paper);
    font-weight: 800;
  }
  .who {
    margin-right: auto;
    font-size: 1.1rem;
  }
</style>
