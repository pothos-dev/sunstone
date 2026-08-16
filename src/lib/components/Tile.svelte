<script lang="ts">
  // A single tiled Tile (slice: multi-concept-tiling). Owns ONE CodeMirror view
  // and every logically per-Tile editor concern for its Concept: the per-tile
  // header, the live-preview view mode, autosave, undo/redo, the review-diff
  // toggle + history stepper, PDF export, the formatting context menu +
  // annotation popup, link / wikilink click navigation (within THIS Tile, pushing
  // THIS Tile's history), broken-link decorations, mermaid theme-sync, and the
  // Properties panel (rendered inline in EVERY visible tile when the global
  // `session.propertiesShown` toggle is on, showing THIS tile's Concept's
  // frontmatter; only the ACTIVE tile's panel is wired to the 'properties' Region
  // + grid cursor — multi-concept-tiling).
  //
  // App.svelte owns the tiling layout and the single 'editor' Region; it renders
  // one <Tile> per tile and delegates active-Tile editor concerns here via a few
  // exported methods (focusView, scrollToDocLine, undo/redo, review + find, the
  // slug-anchor save hook). The same Concept open in two tiles shares one
  // Document (the registry dedupes by path); each Tile's build effect re-syncs its
  // view to the shared buffer via a minimal change, so an edit in one tile shows
  // in the other without jumping the untouched tile's caret.
  import { onDestroy } from 'svelte';
  import { EditorView } from '@codemirror/view';
  import { undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
  import { backend } from '$lib/ipc';
  import { indexStore } from '$lib/state/index.svelte';
  import { session } from '$lib/state/session.svelte';
  import { suggestions } from '$lib/state/suggestions.svelte';
  import { theme } from '$lib/state/theme.svelte';
  import { focus } from '$lib/state/focus.svelte';
  import { treeActions } from '$lib/state/treeActions.svelte';
  import { minimalChange } from '$lib/minimalChange';
  import type { Tile } from '$lib/state/workspace.svelte';
  import {
    buildEditor,
    setEditorConcept,
    setEditorMode,
    setEditorMermaidTheme,
    dispatchFrontmatter,
    refreshBrokenLinkDecorations,
    reconfigureWikiLinks,
    scrollToLine,
    lineAtViewportTop,
    openSearch,
    annotate,
    annotateActionFor,
    toggleBold,
    toggleItalic,
    toggleStrikethrough,
    toggleInlineCode,
    insertOrEditLink,
    linkActionFor,
    copySelection,
    cutSelection,
    pasteFromClipboard,
    selectionForAnnotate,
    addAnnotationWithComment,
    updateAnnotationComment,
    removeAnnotationAt,
    pendingAnchorRenames,
    commitAnchorBaseline,
    type EditorMode,
    type CommentEditRequest,
  } from '$lib/editor/cm';
  import { createTileReview } from '$lib/tileReview.svelte';
  import { parseProperties, type Property } from '$lib/frontmatter';
  import { splitFrontmatter, frontmatterLineCount, findHeadingLine } from '$lib/wasm/exports';
  import { buildEditorMenuItems, type EditorMenuItem } from '$lib/tileEditorMenu';
  import { isReservedFile } from '$lib/reserved';
  import { tileTitle } from '$lib/tileTitle';
  import { ACTIVE_HEADING_PROBE_PX } from '$lib/outlineActive';
  import { region } from '$lib/region';
  import TileHeader from '$lib/components/TileHeader.svelte';
  import Properties from '$lib/components/Properties.svelte';
  import ContextMenu from '$lib/components/ContextMenu.svelte';
  import AnnotationPopup from '$lib/components/AnnotationPopup.svelte';

  interface Props {
    /** The Tile state object (active Concept, history, shared Document). */
    tile: Tile;
    /** Whether this tile is the focused/active Tile (owns the 'properties' Region
     *  + grid cursor when Properties is globally shown). */
    active: boolean;
    /** Whether more than one tile is on screen (gates the Close affordance). */
    multipleTiles: boolean;
    /** App's pending "focus the type field" request path (new-Concept create). */
    focusTypeForPath: string | null;
    /** Ask App to make this tile the active Tile (on focusin / header intent). */
    onActivate: () => void;
    /** Split this Tile's Concept into a new column to the right. */
    onSplitRight: () => void;
    /** Split this Tile's Concept into a new tile below. */
    onSplitDown: () => void;
    /** Close this tile. */
    onClose: () => void;
    /** Report the full-document line at this Tile's viewport probe, so the
     *  Outline can highlight the current heading (outline-active-heading).
     *  Null when nothing is open / the view has no geometry yet. */
    onViewportLine?: (line: number | null) => void;
  }

  let {
    tile,
    active,
    multipleTiles,
    focusTypeForPath,
    onActivate,
    onSplitRight,
    onSplitDown,
    onClose,
    onViewportLine,
  }: Props = $props();

  let editorParent = $state<HTMLDivElement | null>(null);
  let view: EditorView | null = null;

  // The open Concept's frontmatter, mirrored out of the editor's frontmatter
  // field (the single source of truth — ADR 0003) so this Tile's Properties panel
  // and header title can render it.
  let frontmatterProps = $state<Property[]>([]);

  // The editing/read view mode is GLOBAL (session.editorMode), driven by the Edit
  // toggle in this tile's header and applied to EVERY tile at once — it is not a
  // per-Tile setting. This effect subscribes each Tile's live view to that global
  // mode: whenever it changes, the view re-renders in the new mode. Freshly
  // (re)built views adopt it via `initialMode` below. `tile.mode` is kept in sync
  // so the persisted layout stays self-consistent (all tiles share the global mode).
  $effect(() => {
    const mode = session.editorMode;
    tile.mode = mode;
    if (view) {
      setEditorMode(view, mode);
      // Reading vs editing re-lays out the document: re-probe the current heading.
      requestAnimationFrame(reportViewportLine);
    }
  });

  // Whether the editor is in live-editing mode (vs read-only reading), for the
  // header's Edit toggle. Reflects + drives the shared `session.editorMode`.
  const editing = $derived(session.editorMode === 'editing');

  // WEB (ticket 08 §4): the explicit Save button shows only while editing with
  // unsaved changes; its presence IS the dirty indicator (no separate dot).
  // Desktop autosaves, so it never shows there.
  const showSave = $derived(__SUNSTONE_WEB__ && editing && tile.dirty);

  // Toggle live editing. Turning it OFF resolves a dirty buffer first via the
  // Tile's leave path: on web that runs the SAME three-way Save/Discard/Cancel
  // modal as moving a file with a dirty editor (Cancel keeps editing); on
  // desktop (or a clean buffer) it just flushes and proceeds.
  async function toggleEditing(): Promise<void> {
    if (!editing) {
      session.setEditorMode('editing');
      return;
    }
    if (await tile.requestLeave()) session.setEditorMode('read');
  }

  const currentTileTitle = $derived(tileTitle(tile.activePath, frontmatterProps));

  // --- Unified undo/redo over the Tile's single body+frontmatter history -------
  let canUndo = $state(false);
  let canRedo = $state(false);
  function syncHistoryDepths() {
    canUndo = view ? undoDepth(view.state) > 0 : false;
    canRedo = view ? redoDepth(view.state) > 0 : false;
  }
  function doUndo() {
    if (!view) return;
    undo(view);
    view.focus();
    syncHistoryDepths();
  }
  function doRedo() {
    if (!view) return;
    redo(view);
    view.focus();
    syncHistoryDepths();
  }

  // --- Properties panel (per tile, gated by the global toggle) -----------------
  // The Properties panel renders inline in EVERY visible tile when the global
  // `session.propertiesShown` toggle is on (default off → no chrome at all). Only
  // the ACTIVE tile's panel is wired to the single 'properties' Region + the
  // singleton grid cursor; a non-active tile's panel is mouse-editable but takes
  // no part in keyboard grid nav (see the `active` prop on <Properties>).
  const focusTypeNow = $derived(focusTypeForPath !== null && focusTypeForPath === tile.activePath);
  function onPropertiesChange(props: Property[]) {
    if (!view) return;
    dispatchFrontmatter(view, props);
    // WEB (ticket 08 §4): a Properties edit stays IN-MEMORY until the explicit
    // Save — it must NOT eager-commit here (a commit-per-property-edit would
    // defeat the explicit-Save model, exactly like the blur-flush at the editor
    // build below). `dispatchFrontmatter` fires the CM change listener
    // (→ tile.edit → Document.edit), so the Document is already marked dirty and
    // the next Save commits body + frontmatter together as ONE commit. Desktop
    // keeps the eager flush, so its behaviour is byte-identical.
    if (!__SUNSTONE_WEB__) void tile.flush();
  }

  // --- Editor formatting context menu ------------------------------------------
  let editorMenu = $state<{
    x: number;
    y: number;
    items: EditorMenuItem[];
    annotateRange?: { from: number; to: number };
  } | null>(null);
  let editorMenuOverlayId: number | null = null;
  $effect(() => {
    if (editorMenu && editorMenuOverlayId === null) {
      editorMenuOverlayId = focus.pushOverlay(() => (editorMenu = null));
    } else if (!editorMenu && editorMenuOverlayId !== null) {
      focus.removeOverlay(editorMenuOverlayId);
      editorMenuOverlayId = null;
    }
  });

  type AnnotationPopupState = {
    x: number;
    y: number;
    mode: 'add' | 'edit';
    text: string;
    from?: number;
    to?: number;
    anchor?: number;
  };
  let annotationPopup = $state<AnnotationPopupState | null>(null);
  let annotationPopupOverlayId: number | null = null;
  $effect(() => {
    if (annotationPopup && annotationPopupOverlayId === null) {
      annotationPopupOverlayId = focus.pushOverlay(() => (annotationPopup = null));
    } else if (!annotationPopup && annotationPopupOverlayId !== null) {
      focus.removeOverlay(annotationPopupOverlayId);
      annotationPopupOverlayId = null;
    }
  });

  function openCommentPopup(req: CommentEditRequest): void {
    annotationPopup = { x: req.x, y: req.y, mode: 'edit', text: req.text, anchor: req.anchor };
  }

  function onAnnotationSave(text: string): void {
    const p = annotationPopup;
    if (!view || !p) return;
    if (p.mode === 'add') {
      if (p.from != null && p.to != null && text.trim() !== '') {
        addAnnotationWithComment(view, p.from, p.to, text);
      }
    } else if (p.anchor != null) {
      updateAnnotationComment(view, p.anchor, text);
    }
    annotationPopup = null;
  }

  function onAnnotationRemove(): void {
    if (view && annotationPopup?.anchor != null) removeAnnotationAt(view, annotationPopup.anchor);
    annotationPopup = null;
  }

  function openEditorMenu(e: MouseEvent): void {
    if (!view) return;
    const readOnly = view.state.readOnly;
    const range = selectionForAnnotate(view);
    const annAction = annotateActionFor(view);
    const linkAction = linkActionFor(view);

    const { items, annotateUsesSelectionRange } = buildEditorMenuItems({
      readOnly,
      hasSelection: range.from !== range.to,
      annotateAction: annAction,
      linkAction,
    });
    if (items.length === 0) return;

    e.preventDefault();
    editorMenu = {
      x: e.clientX,
      y: e.clientY,
      items,
      annotateRange: annotateUsesSelectionRange ? range : undefined,
    };
  }

  function onEditorMenuSelect(id: string): void {
    if (!view) return;
    switch (id) {
      case 'cut':
        void cutSelection(view);
        break;
      case 'copy':
        void copySelection(view);
        break;
      case 'paste':
        void pasteFromClipboard(view);
        break;
      case 'bold':
        toggleBold(view);
        break;
      case 'italic':
        toggleItalic(view);
        break;
      case 'strike':
        toggleStrikethrough(view);
        break;
      case 'code':
        toggleInlineCode(view);
        break;
      case 'link':
        insertOrEditLink(view);
        break;
      case 'annotate': {
        const range = editorMenu?.annotateRange;
        if (range) {
          annotationPopup = {
            x: editorMenu?.x ?? 0,
            y: editorMenu?.y ?? 0,
            mode: 'add',
            text: '',
            from: range.from,
            to: range.to,
          };
        } else {
          annotate(view);
        }
        break;
      }
    }
  }

  // --- Review changes: working-tree ↔ HEAD (per Tile) --------------------------
  // The state machine (flag, history, stepper, review view) lives in
  // tileReview.svelte.ts; this Tile only wires its path/content/theme in and
  // binds the host element + header/stepper controls to it.
  const review = createTileReview({
    getPath: () => tile.activePath,
    getContent: () => tile.content,
    getTheme: () => theme.resolved,
    focusEditor: () => view?.focus(),
  });

  async function exportPdf(): Promise<void> {
    const path = tile.activePath;
    if (path === null) return;
    await backend.openPrintWindow(path);
  }

  // --- Link / wikilink navigation (navigates THIS Tile, pushes its history) ----
  let pendingScrollLine: number | null = null;
  let pendingScrollAnchor: string | null = null;

  // --- Active-heading reporting (outline-active-heading) -----------------------
  // The Outline highlights the heading whose section the reader is in. The probe
  // lives in the editor's coordinate space, so only this Tile can measure it; it
  // reports the full-document line (the editor doc holds the BODY only, hence the
  // frontmatter offset) and App maps it to an Outline entry.
  // Scrolled to the very end, the probe is useless: the last screenful cannot
  // move up any further, so a heading in it would never light up. Report the
  // viewport's BOTTOM line there instead, which makes the final heading in view
  // the Current one (see the note in `outlineActive.ts`).
  function reportViewportLine(): void {
    if (!view || !onViewportLine) return;
    const sc = view.scrollDOM;
    const atEnd = sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 1;
    const line = atEnd
      ? lineAtViewportTop(view, sc.clientHeight)
      : lineAtViewportTop(view, ACTIVE_HEADING_PROBE_PX);
    onViewportLine(line === null ? null : line + frontmatterLineCount(tile.content));
  }

  function scrollToOutlineLine(line: number) {
    if (!view) return;
    // Headings sit at the top of the viewport — that's where the eye expects
    // them after an outline jump, not floating in the vertical middle.
    scrollToLine(view, line - frontmatterLineCount(tile.content), 'start');
    // A jump that lands where we already were emits no scroll event.
    requestAnimationFrame(reportViewportLine);
  }

  function handleLinkClick(href: string) {
    const open = tile.activePath ?? '';
    const target = indexStore.resolveLink(open, href);
    if (target.kind === 'external') {
      void backend.openExternal(target.href);
    } else if (target.kind === 'internal') {
      handleWikiLinkOpen(target.path, target.anchor);
    } else if (href.trim().startsWith('#')) {
      const line = findHeadingLine(tile.content, href.trim().slice(1));
      if (line !== null) scrollToOutlineLine(line);
    }
  }

  function handleWikiLinkOpen(path: string, anchor: string | null) {
    if (path === (tile.activePath ?? '')) {
      if (anchor !== null && view) {
        const line = findHeadingLine(tile.content, anchor);
        if (line !== null) scrollToOutlineLine(line);
      }
      return;
    }
    pendingScrollAnchor = anchor;
    void tile.open(path);
  }

  // Slug-anchor rewriting after an autosave of this Tile's Concept.
  function handleSaved(savedPath: string): void {
    if (!view || tile.activePath !== savedPath) return;
    const renames = pendingAnchorRenames(view);
    if (renames.length === 0) return;
    const body = view.state.doc.toString();
    const { content: newBody } = indexStore.rewriteAnchorsIn(savedPath, body, renames);
    const change = minimalChange(body, newBody);
    if (change) view.dispatch({ changes: change });
    void backend.rewriteAnchors(savedPath, renames).then((summary) => {
      treeActions.noteRewrite(summary);
    });
    commitAnchorBaseline(view);
  }

  // --- Build / update this Tile's CodeMirror view ------------------------------
  $effect(() => {
    const content = tile.content;
    if (!editorParent) return;

    const { body } = splitFrontmatter(content);
    const props = parseProperties(content);

    if (!view) {
      view = buildEditor({
        parent: editorParent,
        doc: body,
        frontmatter: props,
        path: tile.activePath,
        initialMode: session.editorMode,
        onChange: (full) => tile.edit(full),
        onFrontmatterChange: (p) => (frontmatterProps = p),
        // WEB (ticket 08 §4): persistence is EXPLICIT (Save affordance / Cmd+S /
        // the three-way modal Save path), so the blur auto-flush is suppressed —
        // a commit-per-blur would defeat the explicit-Save model. Desktop keeps
        // the Obsidian-style blur flush, so its behaviour is byte-identical.
        onBlur: () => {
          if (!__SUNSTONE_WEB__) void tile.flush();
        },
        onHistory: syncHistoryDepths,
        onLinkClick: handleLinkClick,
        onCommentEdit: openCommentPopup,
        brokenLinkContext: {
          currentPath: () => tile.activePath ?? '',
        },
        wikiLinkContext: {
          currentPath: () => tile.activePath ?? '',
          open: handleWikiLinkOpen,
        },
      });
      frontmatterProps = props;
      view.dom.setAttribute('data-theme', theme.resolved);
      syncHistoryDepths();
      // Natural scrolling drives the Outline highlight; the listener dies with
      // the view's DOM on destroy.
      view.scrollDOM.addEventListener('scroll', reportViewportLine, { passive: true });
    } else {
      setEditorConcept(view, body, props, tile.activePath);
    }

    if (pendingScrollLine !== null && view) {
      scrollToLine(view, pendingScrollLine);
      pendingScrollLine = null;
    }
    if (pendingScrollAnchor !== null && view) {
      const line = findHeadingLine(tile.content, pendingScrollAnchor);
      if (line !== null) scrollToOutlineLine(line);
      pendingScrollAnchor = null;
    }

    // Re-probe after a build / Concept switch / edit: heading lines move even
    // when the scroll offset does not, so a scroll event alone is not enough.
    // Deferred a frame so CodeMirror has laid the new content out.
    requestAnimationFrame(reportViewportLine);
  });

  // Keep broken-link styling + wikilink resolution fresh.
  $effect(() => {
    void indexStore.version;
    void tile.activePath;
    if (view) {
      refreshBrokenLinkDecorations(view);
      reconfigureWikiLinks(view);
    }
  });

  // Theme: mirror `data-theme` onto this Tile's view(s).
  $effect(() => {
    const resolved = theme.resolved;
    if (view) view.dom.setAttribute('data-theme', resolved);
    review.syncTheme(resolved);
  });

  // Mermaid theme-sync (ADR-0005).
  $effect(() => {
    const resolved = theme.resolved;
    if (view) setEditorMermaidTheme(view, resolved);
  });

  onDestroy(() => {
    if (editorMenuOverlayId !== null) focus.removeOverlay(editorMenuOverlayId);
    if (annotationPopupOverlayId !== null) focus.removeOverlay(annotationPopupOverlayId);
    view?.destroy();
    view = null;
    review.destroy();
  });

  // --- Exported API used by App for the ACTIVE Tile ----------------------------
  export function focusView(): boolean {
    if (!view) return false;
    view.focus();
    return true;
  }
  export function hasView(): boolean {
    return view !== null;
  }
  export function scrollToDocLine(fullDocLine: number): void {
    scrollToOutlineLine(fullDocLine);
  }
  /** Open `path` in this Tile and scroll to `line` once loaded (search result). */
  export function openWithScrollLine(path: string, line: number): void {
    if (tile.activePath === path) {
      if (view) scrollToLine(view, line);
    } else {
      pendingScrollLine = line;
      void tile.open(path);
    }
  }
  export function enterFind(): void {
    if (!view) return;
    view.focus();
    openSearch(view);
  }
  export function undoActive(): void {
    doUndo();
  }
  export function redoActive(): void {
    doRedo();
  }
  export function isReviewActive(): boolean {
    return review.active;
  }
  export function exitReview(): void {
    review.exit();
  }
  export { handleSaved };
  /** Adopt a view mode imperatively, applying it to the live view if built. */
  export function setMode(mode: EditorMode): void {
    tile.mode = mode;
    if (view) setEditorMode(view, mode);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="tile"
  class:tile-active={active}
  data-testid="tile"
  onfocusin={onActivate}
  onpointerdown={onActivate}
>
  <TileHeader
    title={currentTileTitle}
    hasOpenConcept={tile.activePath !== null}
    {editing}
    canGoBack={tile.canGoBack}
    canGoForward={tile.canGoForward}
    {canUndo}
    {canRedo}
    reviewActive={review.active}
    {multipleTiles}
    reviewEnabled={review.avail.enabled}
    reviewTooltip={review.avail.tooltip}
    onBack={() => void tile.back()}
    onForward={() => void tile.forward()}
    onClose={onClose}
    onSplitRight={onSplitRight}
    onSplitDown={onSplitDown}
    onUndo={doUndo}
    onRedo={doRedo}
    onToggleReview={review.toggle}
    onExportPdf={exportPdf}
    onToggleEditing={toggleEditing}
    {showSave}
    onSave={() => void tile.flush()}
    propertiesShown={session.propertiesShown}
    onToggleProperties={() => session.setPropertiesShown(!session.propertiesShown)}
  />

  {#if tile.error}
    <p class="status error">{tile.error}</p>
  {/if}
  {#if !tile.activePath && !tile.error}
    <p class="placeholder" data-testid="placeholder">Select a Concept from the tree.</p>
  {/if}

  {#if session.propertiesShown && tile.activePath && !isReservedFile(tile.activePath)}
    {#if active}
      <!-- Active tile: the single 'properties' Region lives here (grid nav +
           spotlight + Alt-arrow entry). -->
      <div
        class="region-host properties-host"
        class:region-active={focus.focusedRegion === 'properties'}
        data-region="properties"
        use:region={{
          id: 'properties',
          isPresent: () =>
            session.propertiesShown &&
            tile.activePath !== null &&
            !isReservedFile(tile.activePath),
          isVisible: () =>
            session.propertiesShown &&
            tile.activePath !== null &&
            !isReservedFile(tile.activePath),
        }}
      >
        <Properties
          properties={frontmatterProps}
          path={tile.activePath}
          types={suggestions.types}
          keys={suggestions.keys}
          tags={suggestions.tags}
          focusType={focusTypeNow}
          onchange={onPropertiesChange}
          active
        />
      </div>
    {:else}
      <!-- Non-active tile: its own Concept's frontmatter, mouse-editable but not
           part of the Region / keyboard grid nav (active={false}). -->
      <div class="properties-host">
        <Properties
          properties={frontmatterProps}
          path={tile.activePath}
          types={suggestions.types}
          keys={suggestions.keys}
          tags={suggestions.tags}
          focusType={false}
          onchange={onPropertiesChange}
          active={false}
        />
      </div>
    {/if}
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="editor-host"
    class:hidden={!tile.activePath || review.active}
    data-testid="editor"
    bind:this={editorParent}
    oncontextmenu={openEditorMenu}
  ></div>

  {#if review.active}
    <div class="review-stepper" data-testid="review-stepper">
      <button
        type="button"
        class="nav-btn"
        data-testid="review-older"
        title="Compare the previous (older) commit pair"
        aria-label="Older change"
        disabled={!review.stepInfo.canOlder}
        onclick={() => review.step(1)}>← older</button
      >
      <div class="review-stepper-meta">
        <span class="review-comparison" data-testid="review-stepper-label">{review.stepInfo.label}</span>
        {#if review.stepInfo.newer}
          <span class="review-hash" data-testid="review-stepper-hash">{review.stepInfo.newer.hash}</span>
          <span class="review-subject" data-testid="review-stepper-subject">{review.stepInfo.newer.subject}</span>
          <span class="review-date" data-testid="review-stepper-date">{review.stepInfo.newer.relativeDate}</span>
        {/if}
      </div>
      <button
        type="button"
        class="nav-btn"
        data-testid="review-newer"
        title="Compare the next (newer) commit pair"
        aria-label="Newer change"
        disabled={!review.stepInfo.canNewer}
        onclick={() => review.step(-1)}>newer →</button
      >
    </div>
    <div class="editor-host review-host" data-testid="review-editor" bind:this={review.parent}></div>
  {/if}
</div>

{#if editorMenu}
  <ContextMenu
    x={editorMenu.x}
    y={editorMenu.y}
    items={editorMenu.items}
    onselect={onEditorMenuSelect}
    onclose={() => (editorMenu = null)}
  />
{/if}

{#if annotationPopup}
  <AnnotationPopup
    x={annotationPopup.x}
    y={annotationPopup.y}
    mode={annotationPopup.mode}
    initialText={annotationPopup.text}
    onsave={onAnnotationSave}
    onremove={annotationPopup.mode === 'edit' ? onAnnotationRemove : undefined}
    onclose={() => (annotationPopup = null)}
  />
{/if}

<style>
  .tile {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    position: relative;
  }

  .region-active {
    background: var(--region-active);
  }

  .properties-host.region-active :global(.properties) {
    background:
      linear-gradient(var(--region-active), var(--region-active)), var(--bg-sunken);
  }

  .region-host {
    display: block;
  }

  .region-host:focus,
  .editor-host:focus {
    outline: none;
  }

  .editor-host {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  .editor-host.hidden {
    display: none;
  }

  .editor-host :global(.cm-editor) {
    height: 100%;
  }

  .editor-host :global(.cm-editor .cm-content) {
    max-width: var(--reader-max-width, 48rem);
    margin-inline: auto;
    padding-inline: 1.5rem;
  }

  .placeholder,
  .status {
    padding: 1rem;
    color: var(--text-muted);
  }

  .status.error {
    color: var(--danger);
  }

  .review-stepper {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: none;
    padding: 0.35rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    font-size: 0.8rem;
  }

  .review-stepper-meta {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    justify-content: center;
    overflow: hidden;
    white-space: nowrap;
  }

  .review-comparison {
    font-weight: 600;
    color: var(--text);
  }

  .review-hash {
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--accent);
  }

  .review-subject {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .review-date {
    color: var(--text-muted);
    flex: none;
  }

  .review-stepper .nav-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    height: 1.7rem;
    padding: 0 0.55rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.78rem;
    line-height: 1;
    cursor: pointer;
    transition: background 0.12s ease;
  }

  .review-stepper .nav-btn:hover:not(:disabled) {
    background: var(--hover);
  }

  .review-stepper .nav-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
</style>
