<script lang="ts">
  import type { TreeNode } from '$lib/types';
  import { isMarkdownName, stripMd } from '$lib/path';
  import { indexChild, ordinaryChildren as ordinaryChildrenOf } from '$lib/treeNav';
  import Self from './WebTree.svelte';

  interface Props {
    node: TreeNode;
    /** path of the currently-open Concept (for the "open" marker) */
    selected: string | null;
    /** called when a `.md` Concept is opened */
    onopen: (path: string) => void;
    /** whether a folder path is expanded (owned by the viewer) */
    isExpanded: (path: string) => boolean;
    /** toggle a folder's expansion */
    setExpanded: (path: string, open: boolean) => void;
    /** indentation depth (root's children start at 0) */
    depth?: number;
  }

  let { node, selected, onopen, isExpanded, setExpanded, depth = 0 }: Props = $props();

  // A READ-ONLY Explorer tree mirroring the desktop `Tree.svelte`: a disclosure
  // twisty in a fixed caret column (files get an equal-width spacer so labels
  // align), collapsible folders, and reserved files (`index.md`/`log.md`) hidden
  // as ordinary rows — a folder with an `index.md` opens it on a name-click.
  // Deliberately NO dnd / crud / context-menu / focus-Region coupling.
  const expanded = $derived(node.isDir && isExpanded(node.path));
  const indent = $derived(depth * 16);
  const isMarkdown = $derived(!node.isDir && isMarkdownName(node.name));
  const displayName = $derived(node.isDir ? node.name : stripMd(node.name));
  const children = $derived(ordinaryChildrenOf(node));

  // This folder's `index.md`, if any. Clicking the folder name opens it (first
  // click); once it's the open Concept, a further name-click toggles instead.
  const indexPath = $derived(node.isDir ? indexChild(node) : null);

  function toggle() {
    setExpanded(node.path, !expanded);
  }

  // Folder name-click mirrors desktop `onNameClick`: open the index page when
  // there is one and it isn't already open; otherwise toggle expansion.
  function onNameClick() {
    if (indexPath !== null && selected !== indexPath) onopen(indexPath);
    else toggle();
  }
</script>

{#if node.isDir}
  <div class="row dir" style="padding-left: {indent}px" data-testid="tree-dir" data-path={node.path}>
    <!-- Fixed-width caret column: the twisty (accessible control, carries
         aria-expanded + the folder name) toggles expansion; the name button
         opens the index page. -->
    <button
      type="button"
      class="caret-col twisty-toggle"
      aria-expanded={expanded}
      aria-label={displayName}
      onclick={toggle}
    >
      <span class="twisty" class:open={expanded}>▸</span>
    </button>
    <button type="button" class="entry name-toggle" aria-hidden="true" tabindex="-1" onclick={onNameClick}>
      <span class="name">{displayName}</span>
    </button>
  </div>
  {#if expanded}
    <ul class="children">
      {#each children as child (child.path)}
        <li><Self node={child} {selected} {onopen} {isExpanded} {setExpanded} depth={depth + 1} /></li>
      {/each}
    </ul>
  {/if}
{:else if isMarkdown}
  <div class="row file" style="padding-left: {indent}px">
    <!-- Empty caret column keeps file labels aligned with folder labels. -->
    <span class="caret-col spacer" aria-hidden="true"></span>
    <button
      type="button"
      class="entry file-entry"
      class:selected={selected === node.path}
      data-testid="tree-concept"
      data-path={node.path}
      onclick={() => onopen(node.path)}
    >
      <span class="name">{displayName}</span>
    </button>
  </div>
{/if}

<style>
  .children {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .row {
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
  }

  .row.dir:hover {
    background: var(--hover);
  }

  /* Fixed-width disclosure column: folders fill it with the twisty; files get an
     equal-width spacer so labels line up across rows at the same depth. */
  .caret-col {
    flex: 0 0 auto;
    width: 1.25rem;
    align-self: stretch;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .twisty-toggle {
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    padding: 0;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

  .twisty {
    display: block;
    font-size: 0.7rem;
    line-height: 1;
    transition: transform 0.1s ease;
    color: var(--text-muted);
  }

  .twisty.open {
    transform: rotate(90deg);
  }

  .entry {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.15rem 0.4rem;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: background 0.12s ease;
  }

  .entry:hover:not(:disabled) {
    background: var(--hover);
  }

  /* The folder name-toggle is transparent; the row owns the hover highlight. */
  .name-toggle:hover {
    background: none;
  }

  .entry:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -1px;
  }

  .file-entry.selected {
    background: var(--accent-soft);
    color: var(--tag-text);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dir .name {
    font-weight: 600;
  }
</style>
