<script lang="ts">
  import { onMount } from 'svelte';
  import { backend } from '$lib/ipc';
  import { bundle } from '$lib/state/bundle.svelte';
  import { editor } from '$lib/state/editor.svelte';
  import { indexStore } from '$lib/state/index.svelte';
  import { session } from '$lib/state/session.svelte';
  import { suggestions } from '$lib/state/suggestions.svelte';
  import { theme } from '$lib/state/theme.svelte';
  import type { TreeNode } from '$lib/types';
  import { RESERVED_FILES, type ReservedKind } from '$lib/reserved';
  import Tree from '$lib/components/Tree.svelte';
  import TreeCrud from '$lib/components/TreeCrud.svelte';
  import QuickNav from '$lib/components/QuickNav.svelte';
  import SearchPanel from '$lib/components/SearchPanel.svelte';
  import Backlinks from '$lib/components/Backlinks.svelte';
  import Outline from '$lib/components/Outline.svelte';
  import TagBrowser from '$lib/components/TagBrowser.svelte';
  import SidebarSection from '$lib/components/SidebarSection.svelte';
  import SidebarEdge from '$lib/components/SidebarEdge.svelte';
  import ActivityRail from '$lib/components/ActivityRail.svelte';
  import Tile from '$lib/components/Tile.svelte';
  import { treeActions } from '$lib/state/treeActions.svelte';
  import { treeDnd } from '$lib/state/treeDnd.svelte';
  import { focus } from '$lib/state/focus.svelte';
  import { explorerNav } from '$lib/state/explorerNav.svelte';
  import {
    flattenVisible,
    neighborAfterRemoval,
    ordinaryChildren,
    reservedChildren,
  } from '$lib/treeNav';
  import { outlineNav, backlinksNav } from '$lib/state/listFocusNav.svelte';
  import { propertiesNav } from '$lib/state/propertiesNav.svelte';
  import { directionForKey } from '$lib/regionGrid';
  import {
    resizeColumns as layoutResizeColumns,
    resizeTiles as layoutResizeTiles,
    MIN_WEIGHT,
  } from '$lib/tileLayout';
  import { nextTile } from '$lib/tileNav';
  import { resolveStoredLayout } from '$lib/state/layoutPersist';

  interface Props {
    /**
     * WEB build only: the SSR-selected Concept the web app-shell island mounts
     * App with. When the persisted session restores NO layout, this Concept is
     * opened into the single default tile. Defaults to `null`, so the desktop
     * shell (which never passes it) behaves byte-identically.
     */
    initialConcept?: string | null;
  }

  let { initialConcept = null }: Props = $props();

  // The tiling workspace (row of columns of Tiles) behind the editor facade. App
  // renders its layout + drives split/close/resize/active; the facade stays the
  // "active Tile" surface Outline/Backlinks/quick-nav/etc. read from.
  const workspace = editor.workspace;

  // Right-Sidebar expanded count (Outline + Backlinks), see the note below.
  const rightExpandedCount = $derived(
    session.rightSidebarVisible
      ? (session.outlineVisible ? 1 : 0) + (session.backlinksVisible ? 1 : 0)
      : 0,
  );

  let appRoot = $state<HTMLDivElement | null>(null);
  // The editor-area container: the single 'editor' Region (spanning every tile).
  // The active Tile is where focus lands when the Region is entered.
  let editorArea = $state<HTMLDivElement | null>(null);
  let unregisterEditor: (() => void) | null = null;

  // One imperative handle per live Tile component, keyed by Tile id (bound in the
  // layout `{#each}`). App delegates active-Tile editor concerns to the handle for
  // `workspace.activeId` — focus, outline scroll, undo/redo, find, review, and the
  // slug-anchor save hook.
  let tileRefs = $state<Record<string, ReturnType<typeof Tile>>>({});
  const activeTileRef = $derived(tileRefs[workspace.activeId]);

  // Total tiles on screen; the per-Tile Close affordance only appears when there
  // is more than one (closing the last tile would just clear it to empty state).
  const tileCount = $derived(
    workspace.layout.columns.reduce((n, col) => n + col.tiles.length, 0),
  );

  // While a sidebar edge is being dragged we suppress its width transition so it
  // tracks the pointer instantly (the transition otherwise lags every frame).
  let leftResizing = $state(false);
  let rightResizing = $state(false);

  // Quick-nav palette (Ctrl+K) + full-text search (Ctrl+Shift+F) overlays.
  let quickNavOpen = $state(false);
  let quickNavTagActive = $state(false);
  let searchOpen = $state(false);

  // Index-derived autocomplete sources: refresh whenever the index changes.
  $effect(() => {
    void indexStore.version;
    suggestions.refresh();
  });

  // Quick-nav Concept paths: the single source is the wasm handle
  // (`indexStore.conceptPaths()`); re-read whenever the index version bumps
  // (ADR 0006 family 10/16 — retires the `suggestions.conceptPaths` copy).
  const conceptPaths = $derived.by(() => {
    void indexStore.version;
    return indexStore.conceptPaths();
  });

  // The Tags Section is hidden entirely when the Bundle carries no tags.
  const tagsPresent = $derived(suggestions.tags.length > 0);
  const expandedCount = $derived(
    (session.explorerVisible ? 1 : 0) + (tagsPresent && session.tagsVisible ? 1 : 0),
  );

  // New-Concept create focuses the `type` field: the path we want focused. The
  // active Tile's Properties focuses `type` while it matches its open Concept.
  let focusTypeForPath = $state<string | null>(null);

  onMount(() => {
    // Slug-anchor rewriting: after each autosave, reconcile heading-slug changes
    // by rewriting inbound anchors. The edit happened in the focused (active)
    // Tile, so route the save hook to it (its view holds the anchor baseline).
    editor.onSaved = (path) => activeTileRef?.handleSaved(path);

    const stopTheme = theme.start();
    const stopFocus = focus.start();
    focus.onLeaveRegion = (entered) => session.clearTransientRevealsExcept(entered);

    // Register the single 'editor' Region on the editor-area container (spanning
    // all tiles). Its entry point focuses the ACTIVE Tile's view; present/visible
    // whenever a Concept is open.
    if (editorArea) {
      unregisterEditor = focus.register('editor', {
        container: editorArea,
        focus: () => activeTileRef?.focusView() ?? false,
        isPresent: () => editor.path !== null,
        isVisible: () => editor.path !== null,
      });
    }

    void (async () => {
      await Promise.all([bundle.load(), session.load()]);

      // Reconstruct the tiling workspace from the persisted layout: rebuild every
      // column/tile, open each tile's Concept into its Tile, and restore each
      // tile's view-mode + the active tile (layout-persistence). An OLD session
      // (only `lastOpenConcept` + one `editorMode`, no layout) migrates to a
      // single tile; a missing/corrupt/empty layout falls back to the default
      // single empty tile — kept as-is, just adopting the persisted global mode.
      const stored = resolveStoredLayout(
        session.layout,
        session.lastOpenConcept,
        session.editorMode,
      );
      if (stored) {
        await workspace.restore(stored);
      } else {
        // Nothing persisted → the default single empty tile. On the WEB build an
        // `initialConcept` (the SSR-selected Concept) opens into it; desktop
        // passes no prop, so this is skipped and behaviour is unchanged.
        if (initialConcept !== null) await editor.open(initialConcept);
        activeTileRef?.setMode(session.editorMode);
      }

      session.endRestore();

      focusExplorerInitial();
    })();

    void indexStore.refresh();

    // Desktop: App owns the file-change subscription (silent reload of the open
    // buffer + tree/index refresh). WEB (ticket 08): the concurrency coordinator
    // in `WebAppShellIsland` is the SINGLE `onFileChanged` handler — it routes the
    // active buffer through the clean/dirty/deleted flow and refreshes the
    // read-only surfaces itself — so App must NOT also subscribe (it would
    // double-act, silently reloading a buffer the coordinator is guarding).
    const unsubscribe = __SUNSTONE_WEB__
      ? null
      : backend.onFileChanged((change) => {
          void bundle.load();
          void editor.onExternalChange(change.kind, change.paths);
          void indexStore.refresh();
        });

    const onKeydown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        quickNavOpen = !quickNavOpen;
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchOpen = !searchOpen;
        return;
      }

      // Export as PDF: Ctrl/Cmd+P opens the clean print/PDF preview for the active
      // Concept. Only when a Concept is open; otherwise let the browser handle it.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
        if (editor.path === null) return;
        e.preventDefault();
        void backend.openPrintWindow(editor.path);
        return;
      }

      // In-Concept Find: Ctrl/Cmd+F. Focus the active Tile's editor + open its
      // find panel. NO-OP when no Concept is open.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        if (editor.path === null) return;
        e.preventDefault();
        activeTileRef?.enterFind();
        return;
      }

      // Unified undo/redo: route Ctrl/Cmd+Z/Shift+Z/Y to the active Tile's history
      // unless focus is already inside a CodeMirror editor (CM handles it natively).
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        const isUndo = key === 'z' && !e.shiftKey;
        const isRedo = (key === 'z' && e.shiftKey) || key === 'y';
        if (isUndo || isRedo) {
          const inEditor = !!(document.activeElement as HTMLElement | null)?.closest('.cm-editor');
          if (inEditor) return;
          e.preventDefault();
          if (isUndo) activeTileRef?.undoActive();
          else activeTileRef?.redoActive();
          return;
        }
      }

      // Browser-style history: Ctrl+Alt+Left/Right on the active Tile.
      if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          void editor.back();
          return;
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          void editor.forward();
          return;
        }
      }

      // Review mode owns Escape first: exit the active Tile's review view.
      if (
        e.key === 'Escape' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        activeTileRef?.isReviewActive()
      ) {
        e.preventDefault();
        activeTileRef.exitReview();
        return;
      }

      // Escape: the UNIFIED peel — one layer per press, innermost first.
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const propertiesPeel =
          focus.focusedRegion === 'properties' && propertiesNav.mode !== 'nav';
        const editorPeel = focus.focusedRegion === 'editor';
        const quickNavTagPeel = quickNavOpen && quickNavTagActive;
        const localPeelActive = propertiesPeel || editorPeel || quickNavTagPeel;
        if (focus.escape(localPeelActive)) e.preventDefault();
        return;
      }

      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const dir = directionForKey(e.key);
      if (dir !== null) {
        e.preventDefault();
        // Editor grid layer FIRST: when focus is in the editor Region, Alt+arrows
        // move between tiles (left/right → columns, up/down → tiles in a column).
        // Only a move that EXITS the grid edge delegates to the Region backbone,
        // so the leftmost/rightmost column crosses into the sidebars exactly as
        // the single editor does today.
        if (focus.focusedRegion === 'editor') {
          const move = nextTile(workspace.layout, workspace.activeId, dir, workspace.columnMemory);
          if (move.kind === 'tile') {
            focusTile(move.id);
            return;
          }
        }
        focus.moveFocus(dir);
      }
    };
    window.addEventListener('keydown', onKeydown, true);

    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        void editor.back();
      } else if (e.button === 4) {
        e.preventDefault();
        void editor.forward();
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      unsubscribe?.();
      window.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      stopTheme();
      stopFocus();
      focus.onLeaveRegion = null;
      unregisterEditor?.();
      unregisterEditor = null;
    };
  });

  // Apply the resolved theme as `data-theme` on the app root (each Tile's view
  // mirrors it onto its own CodeMirror root).
  $effect(() => {
    const resolved = theme.resolved;
    if (appRoot) appRoot.setAttribute('data-theme', resolved);
  });

  // Persist the last-open Concept whenever active-Tile navigation changes it.
  $effect(() => {
    const path = editor.path;
    if (session.restored) {
      session.setLastOpenConcept(path);
      if (path !== null) session.pushRecentFile(path);
    }
  });

  // Persist the full tiling layout (columns + weights, each tile's Concept +
  // view-mode, and the active tile) whenever it changes, so the workspace is
  // reconstructed on relaunch. `snapshotLayout` reads the reactive workspace
  // state, so this re-runs on split/close/resize/navigation/mode/active changes;
  // gated on `restored` and debounced (via `setLayout`) like other session state.
  $effect(() => {
    const snapshot = workspace.snapshotLayout();
    if (session.restored) session.setLayout(snapshot);
  });

  function openConcept(path: string) {
    focusTypeForPath = null;
    void editor.open(path);
  }

  // Close a tile, then land keyboard focus in the neighbour that inherited the
  // active slot (workspace.closeTile picks it). Closing the last tile clears the
  // Tile to the empty state (no view to focus — focusEditorWhenReady no-ops).
  async function closeTileAndFocus(id: string) {
    await workspace.closeTile(id);
    focusEditorWhenReady();
  }

  // --- Column / tile divider drags (pure size math in `tileLayout.ts`) --------
  // Each drag captures the layout snapshot at pointer-down and applies the total
  // pointer delta (as a fraction of the container axis) from that base, so the
  // clamp is idempotent — dragging past a neighbour's minimum stops cleanly and
  // reversing recovers. Assigning `workspace.layout` keeps every column keyed by
  // id, so the live CodeMirror views survive the re-render (only weights change).
  function onColumnDividerDown(e: PointerEvent, boundaryIndex: number) {
    if (e.button !== 0 || !editorArea) return;
    e.preventDefault();
    const width = Math.max(editorArea.getBoundingClientRect().width, 1);
    const startX = e.clientX;
    const base = workspace.layout;
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort: window listeners below catch the moves regardless */
    }
    const move = (ev: PointerEvent) => {
      const delta = (ev.clientX - startX) / width;
      workspace.layout = layoutResizeColumns(base, boundaryIndex, delta, MIN_WEIGHT);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onTileDividerDown(e: PointerEvent, columnIndex: number, boundaryIndex: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const columnEl = el.parentElement;
    if (!columnEl) return;
    const height = Math.max(columnEl.getBoundingClientRect().height, 1);
    const startY = e.clientY;
    const base = workspace.layout;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort: window listeners below catch the moves regardless */
    }
    const move = (ev: PointerEvent) => {
      const delta = (ev.clientY - startY) / height;
      workspace.layout = layoutResizeTiles(base, columnIndex, boundaryIndex, delta, MIN_WEIGHT);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // --- Explorer keyboard nav + CRUD (unchanged from single-tile) --------------
  let treePane = $state<HTMLDivElement | null>(null);

  function onTreeKeydown(e: KeyboardEvent) {
    const handled = explorerNav.handleKeydown(e, bundle.tree, {
      isExpanded: (p) => session.isExpanded(p),
      setExpanded: (p, open) => session.setExpanded(p, open),
      openConcept: openConceptFromTree,
    });
    if (handled) {
      e.preventDefault();
      return;
    }
    if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) {
      return;
    }
    const crudHandled = explorerNav.handleCrudKeydown(e, {
      rename: (p) => treeCrud?.requestRename(p),
      remove: (p) => {
        const rows = flattenVisible(bundle.tree, (q) => session.isExpanded(q));
        pendingDeleteNeighbor = neighborAfterRemoval(rows, p);
        treeCrud?.requestDelete(p);
      },
      newConcept: (p) => treeCrud?.requestNewConcept(p),
      newFolder: (p) => treeCrud?.requestNewFolder(p),
      move: (p) => treeCrud?.requestMove(p),
    });
    if (crudHandled) e.preventDefault();
  }

  let pendingDeleteNeighbor = $state<string | null>(null);

  function refocusExplorerAt(path: string | null) {
    if (path !== null) explorerNav.setFocused(path);
    let tries = 0;
    const tryFocus = () => {
      const target = explorerNav.focusedPath;
      if (target === null || !treePane) return;
      const row = treePane.querySelector<HTMLElement>(
        `.row[data-row-path="${CSS.escape(target)}"]`,
      );
      if (row) {
        row.focus();
      } else if (tries++ < 10) {
        requestAnimationFrame(tryFocus);
      }
    };
    requestAnimationFrame(tryFocus);
  }

  function focusExplorerInitial() {
    let tries = 0;
    const attempt = () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const root = bundle.tree;
      if (treePane && root) {
        const rows = flattenVisible(root, (q) => session.isExpanded(q));
        const first = rows[0]?.path;
        if (first !== undefined) {
          explorerNav.setFocused(first);
          const row = treePane.querySelector<HTMLElement>(
            `.row[data-row-path="${CSS.escape(first)}"]`,
          );
          if (row) {
            row.focus();
            return;
          }
        }
      }
      if (tries++ < 20) requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  }

  function onCrudCommit(path: string, opts?: { deleted?: boolean }) {
    if (opts?.deleted) {
      refocusExplorerAt(pendingDeleteNeighbor);
      pendingDeleteNeighbor = null;
    } else {
      refocusExplorerAt(path);
    }
  }

  function onCrudCancel() {
    refocusExplorerAt(explorerNav.focusedPath);
    pendingDeleteNeighbor = null;
  }

  function openConceptFromTree(path: string) {
    openConcept(path);
    focusEditorWhenReady();
  }

  // Move keyboard focus to tile `id`: make it the active Tile (so Outline /
  // Backlinks / Properties, which track the active Tile, follow) and focus its
  // CodeMirror view. Retries across frames like `focusEditorWhenReady`, since the
  // target tile's view may still be building. Focusing the view fires its
  // `focusin`, which keeps the 'editor' Region active.
  function focusTile(id: string) {
    workspace.setActive(id);
    let tries = 0;
    const attempt = () => {
      const ref = tileRefs[id];
      if (ref?.hasView()) {
        ref.focusView();
      } else if (tries++ < 10) {
        requestAnimationFrame(attempt);
      }
    };
    requestAnimationFrame(attempt);
  }

  // Focus the active Tile's CodeMirror view once it exists (retry across frames,
  // since the view (re)builds reactively and may be null the next microtask).
  function focusEditorWhenReady() {
    let tries = 0;
    const tryFocus = () => {
      if (activeTileRef?.hasView()) {
        activeTileRef.focusView();
      } else if (tries++ < 10) {
        requestAnimationFrame(tryFocus);
      }
    };
    requestAnimationFrame(tryFocus);
  }

  // Mirror the Explorer Focused-item path into DOM focus while it holds focus.
  $effect(() => {
    const path = explorerNav.focusedPath;
    if (path === null || !treePane) return;
    if (focus.focusedRegion !== 'explorer') return;
    const row = treePane.querySelector<HTMLElement>(
      `.row[data-row-path="${CSS.escape(path)}"]`,
    );
    if (row && document.activeElement !== row) row.focus();
  });

  // --- Outline & Backlinks within-Region keyboard navigation ------------------
  let outlineHost = $state<HTMLDivElement | null>(null);
  let backlinksHost = $state<HTMLDivElement | null>(null);

  function onOutlineKeydown(e: KeyboardEvent) {
    if (!outlineHost) return;
    const count = outlineHost.querySelectorAll('[data-testid="outline-entry"]').length;
    const handled = outlineNav.handleKeydown(e, count, (index) => {
      const entry = outlineHost?.querySelector<HTMLElement>(`[data-index="${index}"]`);
      const line = entry ? Number(entry.dataset.line) : NaN;
      if (Number.isFinite(line)) {
        scrollToOutlineLine(line);
        queueMicrotask(() => activeTileRef?.focusView());
      }
    });
    if (handled) e.preventDefault();
  }

  function onBacklinksKeydown(e: KeyboardEvent) {
    if (!backlinksHost) return;
    const count = backlinksHost.querySelectorAll('[data-testid="backlink"]').length;
    const handled = backlinksNav.handleKeydown(e, count, (index) => {
      const entry = backlinksHost?.querySelector<HTMLElement>(`[data-index="${index}"]`);
      const source = entry?.dataset.path;
      if (source) {
        openConcept(source);
        queueMicrotask(() => activeTileRef?.focusView());
      }
    });
    if (handled) e.preventDefault();
  }

  $effect(() => {
    const index = outlineNav.focusedIndex;
    if (index === null || !outlineHost) return;
    if (focus.focusedRegion !== 'outline') return;
    const entry = outlineHost.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (entry && document.activeElement !== entry) entry.focus();
  });

  $effect(() => {
    const index = backlinksNav.focusedIndex;
    if (index === null || !backlinksHost) return;
    if (focus.focusedRegion !== 'backlinks') return;
    const entry = backlinksHost.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (entry && document.activeElement !== entry) entry.focus();
  });

  // Open a full-text search result in the active Tile, scrolling to the match.
  function openSearchResult(path: string, line: number) {
    focusTypeForPath = null;
    activeTileRef?.openWithScrollLine(path, line);
  }

  // Scroll the active Tile's editor to an Outline heading's full-document line.
  function scrollToOutlineLine(line: number) {
    activeTileRef?.scrollToDocLine(line);
  }

  // --- Tree CRUD: context menu + dialogs --------------------------------------
  let treeCrud = $state<ReturnType<typeof TreeCrud> | null>(null);
  function openMenu(node: TreeNode, x: number, y: number) {
    treeCrud?.openMenu(node, x, y);
  }

  const rootOrdinary = $derived(bundle.tree ? ordinaryChildren(bundle.tree) : []);
  const rootReservedSorted = $derived(bundle.tree ? reservedChildren(bundle.tree) : []);
  const ROOT_RESERVED_GLYPH: Record<ReservedKind, string> = { index: '☰', log: '🕑' };

  $effect(() => {
    const notice = treeActions.notice;
    if (notice === null) return;
    const timer = setTimeout(() => treeActions.dismissNotice(), 4000);
    return () => clearTimeout(timer);
  });
</script>

<div class="app" data-testid="app-root" bind:this={appRoot}>
  <ActivityRail
    onMenu={() => {}}
    onQuickNav={() => (quickNavOpen = !quickNavOpen)}
    onSearch={() => (searchOpen = !searchOpen)}
  />

  <aside
    class="side-bar"
    class:collapsed={!session.leftSidebarVisible}
    class:resizing={leftResizing}
    aria-label="Sidebar"
    data-testid="side-bar"
    style="width: {session.leftSidebarVisible ? session.leftSidebarWidth : 0}px; --side-w: {session.leftSidebarWidth}px; --expanded-count: {expandedCount}"
  >
    <div class="side-bar-inner">
    <SidebarSection
      title="Explorer"
      expanded={session.explorerVisible}
      ontoggle={() => session.setExplorerOpen(!session.explorerOpen)}
      testid="explorer-section"
      region={{
        id: 'explorer',
        isPresent: () => true,
        isVisible: () => session.leftSidebarVisible && session.explorerVisible,
        reveal: () => session.revealLeftSection('explorer'),
      }}
    >
      {#snippet actions()}
        {#if rootReservedSorted.length > 0}
          <div class="root-reserved" data-testid="root-reserved">
            {#each rootReservedSorted as r (r.path)}
              <button
                type="button"
                class="reserved-btn"
                class:selected={editor.path === r.path}
                title={`Open ${RESERVED_FILES[r.kind]} (Bundle root)`}
                aria-label={`Open ${RESERVED_FILES[r.kind]}`}
                data-reserved-path={r.path}
                data-reserved-kind={r.kind}
                onclick={() => openConcept(r.path)}
              >{ROOT_RESERVED_GLYPH[r.kind]}</button>
            {/each}
          </div>
        {/if}
      {/snippet}
      <div
        class="tree-tile"
        class:drop-target={treeDnd.dropTarget === ''}
        bind:this={treePane}
        onkeydown={onTreeKeydown}
        ondragover={(e) => {
          const from = treeDnd.dragging;
          if (from === null || !treeDnd.canDrop(from, '')) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          treeDnd.dropTarget = '';
        }}
        ondragleave={(e) => {
          if (
            e.currentTarget instanceof Node &&
            e.relatedTarget instanceof Node &&
            e.currentTarget.contains(e.relatedTarget)
          )
            return;
          if (treeDnd.dropTarget === '') treeDnd.dropTarget = null;
        }}
        ondrop={(e) => {
          e.preventDefault();
          const from = treeDnd.dragging;
          treeDnd.end();
          if (from !== null && treeDnd.canDrop(from, '')) void treeActions.movePath(from, '');
        }}
        role="presentation"
      >
    {#if bundle.loading}
      <p class="status">Loading…</p>
    {:else if bundle.error}
      <p class="status error">{bundle.error}</p>
    {:else if bundle.tree}
      <div
        class="tree-root"
        data-testid="tree"
        oncontextmenu={(e) => {
          if (e.target === e.currentTarget && bundle.tree) {
            e.preventDefault();
            openMenu(bundle.tree, e.clientX, e.clientY);
          }
        }}
        role="tree"
        tabindex="-1"
      >
        {#each rootOrdinary as child (child.path)}
          <Tree node={child} selected={editor.path} onopen={openConcept} onmenu={openMenu} />
        {/each}
      </div>
      <button
        type="button"
        class="root-new"
        data-testid="root-new-concept"
        onclick={() => bundle.tree && openMenu(bundle.tree, 16, 80)}
      >+ New…</button>
    {/if}
    {#if treeActions.error}
      <p class="status error" data-testid="tree-error">{treeActions.error}</p>
    {/if}
      </div>
    </SidebarSection>

    {#if tagsPresent}
      <SidebarSection
        title="Tags"
        expanded={session.tagsVisible}
        ontoggle={() => session.setTagsOpen(!session.tagsOpen)}
        testid="tags-section"
        region={{
          id: 'tags',
          isPresent: () => tagsPresent,
          isVisible: () => tagsPresent && session.leftSidebarVisible && session.tagsVisible,
          reveal: () => session.revealLeftSection('tags'),
        }}
      >
        <TagBrowser
          version={indexStore.version}
          selected={editor.path}
          onopen={openConcept}
          onopenFocus={(p) => {
            openConcept(p);
            focusEditorWhenReady();
          }}
        />
      </SidebarSection>
    {/if}
    </div>
  </aside>

  <!-- The left Sidebar's border: click to collapse/expand, drag to resize. -->
  <SidebarEdge
    side="left"
    open={session.leftSidebarOpen}
    width={session.leftSidebarWidth}
    label="sidebar"
    testid="left-sidebar-edge"
    onToggle={() => session.setLeftSidebarOpen(!session.leftSidebarOpen)}
    onResize={(w) => session.setLeftSidebarWidth(w)}
    onResizeStart={() => (leftResizing = true)}
    onResizeEnd={() => (leftResizing = false)}
  />

  <main class="editor-tile" aria-label="Concept">
    <!-- The editor area: a ROW OF COLUMNS, each a vertical STACK of tiled Tiles,
         with draggable dividers between columns and between tiles. It is the
         single 'editor' Region; the active Tile is where focus lands on entry.
         (Sizing math lives in the pure `tileLayout.ts`; this just renders it.) -->
    <div
      class="editor-area"
      class:region-active={focus.focusedRegion === 'editor'}
      data-region="editor"
      data-testid="editor-area"
      bind:this={editorArea}
    >
      {#each workspace.layout.columns as col, ci (col.id)}
        <div class="editor-column" style="flex-grow: {col.weight}">
          {#each col.tiles as slot, ti (slot.id)}
            {@const tile = workspace.tileById(slot.id)}
            {#if tile}
              <div class="editor-tile" style="flex-grow: {slot.weight}">
                <Tile
                  bind:this={tileRefs[tile.id]}
                  {tile}
                  active={tile.id === workspace.activeId}
                  multipleTiles={tileCount > 1}
                  {focusTypeForPath}
                  onActivate={() => workspace.setActive(tile.id)}
                  onSplitRight={() => {
                    workspace.setActive(tile.id);
                    workspace.splitRight();
                  }}
                  onSplitDown={() => {
                    workspace.setActive(tile.id);
                    workspace.splitDown();
                  }}
                  onClose={() => void closeTileAndFocus(tile.id)}
                />
              </div>
            {/if}
            {#if ti < col.tiles.length - 1}
              <div
                class="tile-divider"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize tiles"
                data-testid="tile-divider"
                onpointerdown={(e) => onTileDividerDown(e, ci, ti)}
              ></div>
            {/if}
          {/each}
        </div>
        {#if ci < workspace.layout.columns.length - 1}
          <div
            class="column-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize columns"
            data-testid="column-divider"
            onpointerdown={(e) => onColumnDividerDown(e, ci)}
          ></div>
        {/if}
      {/each}
    </div>
  </main>

  <!-- The right Sidebar's border: click to collapse/expand, drag to resize. -->
  <SidebarEdge
    side="right"
    open={session.rightSidebarOpen}
    width={session.rightSidebarWidth}
    label="Outline & Backlinks"
    testid="right-sidebar-edge"
    onToggle={() => session.setRightSidebarOpen(!session.rightSidebarOpen)}
    onResize={(w) => session.setRightSidebarWidth(w)}
    onResizeStart={() => (rightResizing = true)}
    onResizeEnd={() => (rightResizing = false)}
  />

  <aside
    class="side-bar right-side-bar"
    class:collapsed={!session.rightSidebarVisible}
    class:resizing={rightResizing}
    aria-label="Outline & Backlinks"
    data-testid="right-side-bar"
    style="width: {session.rightSidebarVisible ? session.rightSidebarWidth : 0}px; --side-w: {session.rightSidebarWidth}px; --expanded-count: {rightExpandedCount}"
  >
    <div class="side-bar-inner">
      <SidebarSection
        title="Outline"
        expanded={session.outlineVisible}
        ontoggle={() => session.setOutlineOpen(!session.outlineOpen)}
        testid="outline-section"
        region={{
          id: 'outline',
          isPresent: () => editor.path !== null,
          isVisible: () =>
            session.rightSidebarVisible && session.outlineVisible && editor.path !== null,
          reveal: () => session.revealRightSection('outline'),
        }}
      >
        <div
          class="region-host"
          bind:this={outlineHost}
          onkeydown={onOutlineKeydown}
          role="presentation"
        >
          <Outline path={editor.path} content={editor.content} onselect={scrollToOutlineLine} />
        </div>
      </SidebarSection>
      <SidebarSection
        title="Backlinks"
        expanded={session.backlinksVisible}
        ontoggle={() => session.setBacklinksOpen(!session.backlinksOpen)}
        testid="backlinks-section"
        region={{
          id: 'backlinks',
          isPresent: () => editor.path !== null,
          isVisible: () =>
            session.rightSidebarVisible && session.backlinksVisible && editor.path !== null,
          reveal: () => session.revealRightSection('backlinks'),
        }}
      >
        <div
          class="region-host"
          bind:this={backlinksHost}
          onkeydown={onBacklinksKeydown}
          role="presentation"
        >
          <Backlinks path={editor.path} version={indexStore.version} onopen={openConcept} />
        </div>
      </SidebarSection>
    </div>
  </aside>

  <QuickNav
    open={quickNavOpen}
    paths={conceptPaths}
    tags={suggestions.tags}
    recent={session.recentFiles}
    conceptsForTag={(tag) => backend.conceptsByTag(tag)}
    bind:tagActive={quickNavTagActive}
    onopen={(p) => {
      openConcept(p);
      focusEditorWhenReady();
    }}
    onclose={() => (quickNavOpen = false)}
  />

  <SearchPanel
    open={searchOpen}
    onopen={(path, line) => {
      openSearchResult(path, line);
      focusEditorWhenReady();
    }}
    onclose={() => (searchOpen = false)}
  />

  <TreeCrud
    bind:this={treeCrud}
    bind:focusTypeForPath
    oncommit={onCrudCommit}
    oncancel={onCrudCancel}
  />

  {#if treeActions.notice}
    <div class="toast" role="status" aria-live="polite" data-testid="rewrite-toast">
      {treeActions.notice.message}
    </div>
  {/if}
</div>

<style>
  .app {
    display: grid;
    /* Far-left activity rail (fixed) | collapsible left Sidebar | its resize edge
       | editor | right resize edge | right Sidebar. The rail and both edges sit
       OUTSIDE the collapsing Sidebars, so the edge stays a click target to
       re-expand a Sidebar that has collapsed to 0 width. */
    grid-template-columns: auto auto auto 1fr auto auto;
    height: 100vh;
    overflow: hidden;
    color: var(--text);
    /* Warm sunlit gradient behind the shell; tiles paint their own solid
       surfaces on top, so it reads through gutters and translucent chrome. */
    background: var(--bg-gradient, var(--bg));
  }

  .side-bar {
    /* Width is driven inline from the persisted `leftSidebarWidth` /
       `rightSidebarWidth` (0 when collapsed). The inner keeps the FULL width
       (via `--side-w`) so collapsing slides the content out under the clip
       rather than reflowing it. */
    height: 100vh;
    overflow: hidden;
    display: flex;
    justify-content: flex-end;
    border-right: 1px solid var(--border);
    background: var(--bg-elevated);
    transition: width 0.22s ease;
  }

  /* Suppress the transition while dragging the edge so the width tracks the
     pointer instantly. */
  .side-bar.resizing {
    transition: none;
  }

  .side-bar.collapsed {
    border-right-width: 0;
  }

  .right-side-bar {
    justify-content: flex-start;
    border-right: none;
    border-left: 1px solid var(--border);
  }

  .right-side-bar.collapsed {
    border-left-width: 0;
    border-right-width: 0;
  }

  .side-bar-inner {
    flex: none;
    width: var(--side-w, 280px);
    height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
    font-size: 0.9rem;
  }

  .tree-tile {
    padding: 0.5rem;
    font-size: 14px;
  }

  /* Active-Region affordance: a subtle brighter background on the active Region's
     container (see region-focus-backbone). */
  .region-active {
    background: var(--region-active);
  }

  .region-host:focus,
  .tree-tile:focus {
    outline: none;
  }

  .region-host {
    display: block;
  }

  .tree-tile.drop-target {
    box-shadow: inset 0 0 0 1px var(--accent-ring);
    border-radius: var(--radius-sm);
  }

  .editor-tile {
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }

  /* The tiling editor area: a horizontal row of columns. */
  .editor-area {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: row;
    overflow: hidden;
  }

  /* A column: a vertical stack of tiles. `flex-grow` carries its weight; a shared
     `flex-basis: 0` makes the grow ratios the exact size ratios. */
  .editor-column {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .editor-tile {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Draggable dividers between columns / between tiles. A comfortable hit-strip
     (a few px) drawn transparent, with a centred hairline via a pseudo so the
     visible seam stays 1px while the whole strip is grabbable. The cursor signals
     the drag axis; hovering brightens the hairline to the accent. */
  .column-divider,
  .tile-divider {
    flex: none;
    position: relative;
    background: transparent;
    touch-action: none;
  }

  .column-divider {
    width: 7px;
    cursor: col-resize;
  }

  .tile-divider {
    height: 7px;
    cursor: row-resize;
  }

  .column-divider::after,
  .tile-divider::after {
    content: '';
    position: absolute;
    background: var(--border);
    transition: background 0.12s ease;
  }

  .column-divider::after {
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    transform: translateX(-50%);
  }

  .tile-divider::after {
    left: 0;
    right: 0;
    top: 50%;
    height: 1px;
    transform: translateY(-50%);
  }

  .column-divider:hover::after,
  .tile-divider:hover::after {
    background: var(--accent);
  }

  .status {
    padding: 1rem;
    color: var(--text-muted);
  }

  .status.error {
    color: var(--danger);
  }

  .toast {
    position: fixed;
    bottom: 1.25rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    padding: 0.55rem 0.95rem;
    border-radius: var(--radius-pill);
    background: var(--accent);
    color: var(--accent-contrast);
    font-size: 0.82rem;
    font-weight: 600;
    box-shadow: var(--shadow-md);
    pointer-events: none;
  }

  .root-reserved {
    display: flex;
    align-items: center;
    gap: 0.1rem;
  }

  .reserved-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.85rem;
    line-height: 1;
    cursor: pointer;
    opacity: 0.75;
    transition: background 0.12s ease;
  }

  .reserved-btn:hover {
    background: var(--hover);
    opacity: 1;
  }

  .reserved-btn:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -1px;
    opacity: 1;
  }

  .reserved-btn.selected {
    background: var(--accent-soft);
    color: var(--tag-text);
    opacity: 1;
  }

  .root-new {
    margin: 0.3rem 0.1rem;
    padding: 0.25rem 0.6rem;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    opacity: 0.8;
    transition: background 0.12s ease;
  }

  .root-new:hover {
    background: var(--hover);
    opacity: 1;
  }
</style>
