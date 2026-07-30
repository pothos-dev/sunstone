<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { TreeNode } from '$lib/types';
  import { dirname, stripMd } from '$lib/path';
  import { session } from '$lib/state/session.svelte';
  import { treeActions } from '$lib/state/treeActions.svelte';
  import { treeDnd } from '$lib/state/treeDnd.svelte';
  import { explorerNav } from '$lib/state/explorerNav.svelte';
  import { ordinaryChildren as ordinaryChildrenOf } from '$lib/treeNav';
  import { isReservedFile, reservedKind, RESERVED_FILES, type ReservedKind } from '$lib/reserved';
  import Self from './Tree.svelte';

  interface Props {
    node: TreeNode;
    /** path of the currently-open Concept, for the filled-accent "open" marker */
    selected: string | null;
    /** called when a `.md` file is clicked */
    onopen: (path: string) => void;
    /** called on right-click with the node + coords */
    onmenu: (node: TreeNode, x: number, y: number) => void;
    /** depth for indentation (root's children start at 0) */
    depth?: number;
  }

  let { node, selected, onopen, onmenu, depth = 0 }: Props = $props();

  // The Focused item (keyboard cursor) is INDEPENDENT of the open Concept
  // (docs/GLOSSARY.md): this row carries the roving `tabindex="0"` + the spotlight ring
  // when it is the Explorer's Focused item, every other row stays `tabindex="-1"`.
  const isFocusedItem = $derived(explorerNav.focusedPath === node.path);

  // Clicking a row makes it the Focused item too (in addition to opening, for a
  // Concept). Wired onto the row's interactive controls (the folder toggle / the
  // file entry button) rather than the row container, so it never interferes
  // with the start of a drag and keeps the row's a11y semantics clean.
  function focusRow() {
    explorerNav.setFocused(node.path);
  }

  function toggleAndFocus() {
    focusRow();
    toggle();
  }

  // Clicking a folder's NAME (slice: reserved-files / explorer tree). A folder
  // that has an index page opens it on the first click; once that index page is
  // already open, a further click toggles expansion instead. A folder WITHOUT an
  // index page just toggles expansion on every click. The disclosure twisty
  // (`toggleAndFocus`) always toggles, so expansion stays one click away either
  // way.
  function onNameClick() {
    focusRow();
    if (indexPath !== null && selected !== indexPath) {
      onopen(indexPath);
    } else {
      toggle();
    }
  }

  function openMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onmenu(node, e.clientX, e.clientY);
  }

  // Expanded state is owned by the session store (persisted per-Bundle, restored
  // on launch). A fresh Bundle starts with every folder collapsed, so reading it
  // here gives the restored set (empty by default). Toggling reports back to the
  // store, which persists.
  const expanded = $derived(node.isDir && session.isExpanded(node.path));

  const indent = $derived(depth * 16);

  function toggle() {
    session.setExpanded(node.path, !expanded);
  }

  const isMarkdown = $derived(!node.isDir && node.name.toLowerCase().endsWith('.md'));

  // Drag-and-drop moving (slice: tree-dnd). Folders and Concepts (`.md` files)
  // can be dragged. The drop TARGET resolves to a folder: a folder row means
  // "move INTO this folder"; a file row resolves to its PARENT folder, so a
  // slightly-off drop onto a sibling Concept is a safe no-op rather than a
  // surprise move. Dropping onto empty tree space targets the Bundle root — that
  // zone lives on `.tree-tile` in App.svelte.
  const draggable = $derived(node.isDir || isMarkdown);
  const dropDir = $derived(node.isDir ? node.path : dirname(node.path));
  // Only folder rows show the highlight; a hovered file lights up its PARENT.
  const isDropTarget = $derived(node.isDir && treeDnd.dropTarget === node.path);

  function onDragStart(e: DragEvent) {
    if (!draggable) return;
    treeDnd.start(node.path);
    // Firefox only initiates a drag once `setData` is called; the path also
    // rides along as a courtesy for anything reading the dropped payload.
    e.dataTransfer?.setData('text/plain', node.path);
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    // WebKitGTK (Tauri's Linux webview) builds the *default* drag ghost from a
    // device-pixel snapshot but paints it back at CSS size, so on a HiDPI
    // display the ghost comes out at 2× the row. Handing it an explicit drag
    // image — a clone pinned to the row's CSS width — bypasses that faulty
    // snapshot path and renders at the true size everywhere.
    const row = e.currentTarget as HTMLElement;
    const rect = row.getBoundingClientRect();
    const ghost = row.cloneNode(true) as HTMLElement;
    ghost.style.width = `${rect.width}px`;
    ghost.style.position = 'fixed';
    ghost.style.top = '-9999px';
    ghost.style.left = '0';
    ghost.style.pointerEvents = 'none';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, e.clientX - rect.left, e.clientY - rect.top);
    // The clone only has to survive the synchronous snapshot; drop it next tick.
    setTimeout(() => ghost.remove(), 0);
  }

  // Hovering a collapsed folder mid-drag springs it open after a beat, so a
  // Concept can be dropped into a nested folder without a separate expand click.
  let expandTimer: ReturnType<typeof setTimeout> | null = null;
  function clearExpandTimer() {
    if (expandTimer !== null) {
      clearTimeout(expandTimer);
      expandTimer = null;
    }
  }

  // A row can be destroyed (parent collapsed/re-rendered) while a drag-hover
  // expand timer is still pending; without this the timer fires later against
  // a stale/unmounted node.
  onDestroy(clearExpandTimer);

  function onDragOver(e: DragEvent) {
    const from = treeDnd.dragging;
    if (from === null || !treeDnd.canDrop(from, dropDir)) return;
    e.preventDefault(); // a missing preventDefault here means "not a drop target"
    e.stopPropagation(); // handled here — don't also trigger the root drop zone
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    treeDnd.dropTarget = dropDir;
    if (node.isDir && !expanded && expandTimer === null) {
      expandTimer = setTimeout(() => session.setExpanded(node.path, true), 600);
    }
  }

  function onDragLeave(e: DragEvent) {
    // Ignore leaves into our own descendants; only clear when the pointer
    // actually exits this row.
    if (e.currentTarget instanceof Node && e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) {
      return;
    }
    clearExpandTimer();
    if (treeDnd.dropTarget === dropDir) treeDnd.dropTarget = null;
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    clearExpandTimer();
    const from = treeDnd.dragging;
    treeDnd.end();
    if (from !== null && treeDnd.canDrop(from, dropDir)) void treeActions.movePath(from, dropDir);
  }

  // The tree shows only Concepts (`.md` files) and folders; any other file type
  // in the Bundle is ignored. Displayed names omit the `.md` extension.
  const displayName = $derived(node.isDir ? node.name : stripMd(node.name));

  // Reserved files (`index.md`/`log.md`) are NOT shown as ordinary tree leaves;
  // they are surfaced as per-folder affordances on the containing folder row
  // instead. Strip them — and any non-markdown file — from the normal child
  // listing here (slice: reserved-files).
  const ordinaryChildren = $derived(ordinaryChildrenOf(node));

  // This folder's index page (`index.md`), if it has one. There is no longer an
  // index icon: clicking the folder name opens it (see `onNameClick`), so the
  // path is all we need here.
  const indexPath = $derived(
    node.isDir
      ? ((node.children ?? []).find(
          (c) => !c.isDir && isReservedFile(c.path) && reservedKind(c.path) === 'index',
        )?.path ?? null)
      : null,
  );

  // The reserved files surfaced as folder-row icons, in a stable order, each as
  // { kind, path } so the affordance can open it. `index` is deliberately
  // excluded — it is reached by clicking the folder name instead — leaving just
  // `log`. The icon opens it like any other Concept (normal markdown editing).
  const RESERVED_ORDER: ReservedKind[] = ['index', 'log'];
  const reservedAffordances = $derived(
    node.isDir
      ? (node.children ?? [])
          .filter((c) => !c.isDir && isReservedFile(c.path) && reservedKind(c.path) !== 'index')
          .map((c) => ({ kind: reservedKind(c.path) as ReservedKind, path: c.path }))
          .sort((a, b) => RESERVED_ORDER.indexOf(a.kind) - RESERVED_ORDER.indexOf(b.kind))
      : [],
  );

  /** A small glyph per reserved kind for the folder-row affordance. */
  const RESERVED_GLYPH: Record<ReservedKind, string> = { index: '☰', log: '🕑' };
</script>

{#if node.isDir}
  <div
    class="row dir"
    class:drop-target={isDropTarget}
    class:focused-item={isFocusedItem}
    data-row-path={node.path}
    style="padding-left: {indent}px"
    oncontextmenu={openMenu}
    {draggable}
    ondragstart={onDragStart}
    ondragend={() => treeDnd.end()}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
    role="treeitem"
    aria-selected="false"
    aria-expanded={expanded}
    tabindex={isFocusedItem ? 0 : -1}
  >
    <!-- The disclosure twisty sits in a fixed-width caret column so folder and
         file labels line up at the same depth (files get an equal-width spacer)
         and children indent cleanly past their parent. The twisty button is the
         accessible control (carries aria-expanded + the folder's accessible
         name) and always toggles expansion; the name button (below) opens the
         index page when there is one, and is hidden from assistive tech to avoid
         a duplicate announcement. Any reserved-file icons (just `log` now) sit
         between the caret and the label. -->
    <button
      class="caret-col twisty-toggle"
      type="button"
      tabindex="-1"
      onclick={toggleAndFocus}
      aria-expanded={expanded}
      aria-label={displayName}
    >
      <span class="twisty" class:open={expanded}>▸</span>
    </button>
    {#each reservedAffordances as r (r.path)}
      <button
        class="reserved-btn"
        class:selected={selected === r.path}
        type="button"
        tabindex="-1"
        title={`Open ${RESERVED_FILES[r.kind]}`}
        aria-label={`Open ${RESERVED_FILES[r.kind]}`}
        data-reserved-path={r.path}
        data-reserved-kind={r.kind}
        onclick={(e) => {
          e.stopPropagation();
          onopen(r.path);
        }}
      >{RESERVED_GLYPH[r.kind]}</button>
    {/each}
    <button
      class="entry dir-toggle name-toggle"
      type="button"
      onclick={onNameClick}
      tabindex="-1"
      aria-hidden="true"
    >
      <span class="name">{displayName}</span>
    </button>
  </div>
  {#if expanded}
    <ul class="children">
      {#each ordinaryChildren as child (child.path)}
        <li>
          <Self node={child} {selected} {onopen} {onmenu} depth={depth + 1} />
        </li>
      {/each}
    </ul>
  {/if}
{:else}
  <div
    class="row file"
    class:focused-item={isFocusedItem}
    data-row-path={node.path}
    style="padding-left: {indent}px"
    oncontextmenu={openMenu}
    draggable={isMarkdown}
    ondragstart={onDragStart}
    ondragend={() => treeDnd.end()}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
    role="treeitem"
    aria-selected={selected === node.path}
    tabindex={isFocusedItem ? 0 : -1}
  >
    <!-- Empty caret column: keeps file labels aligned with folder labels at the
         same depth (folders fill this column with their twisty). -->
    <span class="caret-col spacer" aria-hidden="true"></span>
    <button
      class="entry file-entry"
      class:selected={selected === node.path}
      class:nonmd={!isMarkdown}
      type="button"
      tabindex="-1"
      disabled={!isMarkdown}
      data-path={node.path}
      onclick={() => {
        focusRow();
        if (isMarkdown) onopen(node.path);
      }}
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

  /* The Focused item (keyboard cursor) — the spotlight focus ring. Distinct
     from the open Concept's filled accent (`.file-entry.selected`): they
     coincide right after Enter-open and diverge as the keyboard moves away.

     The ring shows ONLY while the row actually holds focus (`:focus-within`),
     i.e. while the Explorer Region is the active Region — the `.focused-item`
     class persists as the roving tab target even when focus is elsewhere, but a
     remembered cursor in an UNFOCUSED Region must not paint a second spotlight.
     `:focus-within` (not `:focus-visible`) because the row is focused
     PROGRAMMATICALLY and a programmatic `.focus()` does not reliably set
     `:focus-visible`; `:focus-within` also covers the brief moment an inner
     (tabindex=-1) button holds focus before the row-focus effect runs. Its
     higher specificity also beats `.row:focus { outline: none }` below, which
     would otherwise suppress the ring exactly while the row is focused. */
  .row.focused-item:focus-within {
    outline: 2px solid var(--accent-ring);
    outline-offset: -2px;
  }

  /* Suppress the row's own default outline on plain focus; the `.focused-item`
     ring above is the affordance, and the inner buttons carry tabindex=-1. */
  .row:focus {
    outline: none;
  }

  /* Folder rows highlight as a whole (the twisty/name halves are transparent),
     so the split toggle still reads as one row. */
  .row.dir:hover {
    background: var(--hover);
  }

  /* The folder under the dragged Concept while a move is in flight. */
  .row.dir.drop-target {
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent-ring);
    border-radius: var(--radius-sm);
  }

  /* The dragged row dims so it reads as "in transit". */
  .row[draggable='true']:active {
    cursor: grabbing;
  }

  .reserved-btn {
    flex: 0 0 auto;
    width: 1.4rem;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.8rem;
    line-height: 1;
    cursor: pointer;
    border-radius: var(--radius-sm);
    opacity: 0.55;
    transition: background 0.12s ease;
  }

  .reserved-btn:hover {
    background: var(--hover);
    opacity: 1;
  }

  .reserved-btn.selected {
    opacity: 1;
    background: var(--accent-soft);
    color: var(--tag-text);
  }

  .reserved-btn:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -1px;
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

  /* Fixed-width disclosure column. Folders fill it with the twisty; files get an
     empty spacer of the same width (`.spacer`), so labels line up across rows at
     the same depth and each nesting level indents cleanly by `--indent-step`.
     Flex-centred so the caret glyph sits on the row's optical centre. */
  .caret-col {
    flex: 0 0 auto;
    width: 1.25rem;
    align-self: stretch;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* The twisty half is a bare button (no .entry chrome) — the row owns the hover
     highlight (see `.row.dir:hover`), so it stays transparent. */
  .twisty-toggle {
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    padding: 0;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

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

  .file-entry.nonmd {
    cursor: default;
    opacity: 0.5;
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

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dir .name {
    font-weight: 600;
  }
</style>
