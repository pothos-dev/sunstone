<script lang="ts">
  // PROTOTYPE — instrument, not design: the config.json as loaded vs. what Save
  // would write, line-diffed, so "only the keys you touched change" is visible.
  import { lcsDiff } from '$lib/diff/diffToCriticMarkup';
  import { draft } from './draft.svelte';

  let expanded = $state(false);
  // Opens itself on the first edit, so the page is judged unobstructed until then.
  let wasDirty = false;
  $effect(() => {
    if (draft.dirty && !wasDirty) expanded = true;
    wasDirty = draft.dirty;
  });

  const lines = $derived.by(() => {
    const before = JSON.stringify(draft.original, null, 2).split('\n');
    const after = JSON.stringify(draft.config, null, 2).split('\n');
    const out: { kind: 'same' | 'add' | 'del'; text: string }[] = [];
    for (const run of lcsDiff(before, after)) {
      const kind = run.op === 'equal' ? 'same' : run.op === 'insert' ? 'add' : 'del';
      for (const text of run.items) out.push({ kind, text });
    }
    return out;
  });
</script>

<aside class="drawer" class:collapsed={!expanded}>
  <button type="button" class="head" onclick={() => (expanded = !expanded)}>
    <span>PROTOTYPE · config.json {draft.dirty ? `· ${draft.edits.size} edit${draft.edits.size === 1 ? '' : 's'}` : '· unchanged'}</span>
    <span>{expanded ? '▾' : '▸'}</span>
  </button>
  {#if expanded}
    <pre>{#each lines as l, i (i)}<div class={l.kind}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '} {l.text}</div>{/each}</pre>
    <div class="actions">
      <button type="button" disabled={!draft.dirty} onclick={() => draft.discard()}>Discard</button>
      <button type="button" disabled={!draft.dirty} onclick={() => draft.save()}>Save (in memory)</button>
    </div>
  {/if}
</aside>

<style>
  .drawer {
    position: fixed;
    right: 14px;
    bottom: 14px;
    z-index: 3000;
    width: 25rem;
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    border-radius: 10px;
    background: #111;
    color: #ddd;
    font: 12px/1.45 ui-monospace, monospace;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }
  .head {
    display: flex;
    justify-content: space-between;
    padding: 8px 12px;
    border: 0;
    background: #222;
    color: #fff;
    font: inherit;
    cursor: pointer;
  }
  pre {
    margin: 0;
    padding: 8px 0;
    overflow: auto;
    flex: 1 1 auto;
  }
  pre div {
    padding: 0 12px;
    white-space: pre;
  }
  .add {
    background: rgba(60, 180, 90, 0.25);
    color: #b5f5c5;
  }
  .del {
    background: rgba(220, 70, 70, 0.25);
    color: #ffc0c0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px 12px;
    background: #1a1a1a;
  }
  .actions button {
    padding: 4px 10px;
    border: 1px solid #444;
    border-radius: 6px;
    background: #2a2a2a;
    color: #fff;
    font: inherit;
    cursor: pointer;
  }
  .actions button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
