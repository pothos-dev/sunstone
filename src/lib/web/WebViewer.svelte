<script lang="ts">
  import type { TreeNode, TagCount } from '$lib/types';
  import type { RenderPayload } from './render';
  import type { Component } from 'svelte';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto, invalidateAll } from '$app/navigation';
  import { backend } from '$lib/ipc';
  import { editToggleLabel } from './concurrency';
  import type { WebEditorApi } from './WebEditorIsland.svelte';
  import { theme } from '$lib/state/theme.svelte';
  import { ordinaryChildren, reservedChildren } from '$lib/treeNav';
  import { RESERVED_FILES, type ReservedKind } from '$lib/reserved';
  import SidebarSection from '$lib/components/SidebarSection.svelte';
  import WebAppShellIsland from './WebAppShellIsland.svelte';
  import WebTree from './WebTree.svelte';
  import WebSearch from './WebSearch.svelte';
  import WebTags from './WebTags.svelte';
  import WebOutline from './WebOutline.svelte';
  import WebBacklinks from './WebBacklinks.svelte';
  import { hydrateMermaid } from './webMermaid';
  import { loadUiState, saveUiState, type WebUiState } from './uiState';
  import { conceptTitle } from './conceptUrl';
  import { conceptToUrl } from '$lib/wasm/exports';
  import { ensureWasm } from '$lib/wasm';

  interface Props {
    /** SSR'd data from `+page.ts`'s `load` (talks to the Rust server). */
    data: {
      bundleRoot: string;
      tree: TreeNode;
      selected: string | null;
      rendered: RenderPayload | null;
      renderError: string | null;
      /** Authenticated user (Auth.js session), or null when signed out. The
       *  Edit affordance is shown ONLY when this is present (ticket 06). */
      user: { name: string } | null;
    };
  }

  let { data }: Props = $props();

  // WP0: an AUTHENTICATED user gets the FULL desktop `App.svelte` shell (mounted
  // via the client-only `WebAppShellIsland`); an anonymous user keeps this SSR
  // read surface. `showApp` is flipped in `onMount` (NOT a `browser`-derived) so
  // SSR + the first hydration render the read surface identically, avoiding a
  // hydration mismatch; it then flips on the client for a signed-in user.
  let showApp = $state(false);

  // --- Editing (ticket 06): viewer stays the SSR default; an Edit toggle swaps
  // the CENTER rendered article for the client-only editor island in place. The
  // island (and, transitively, CodeMirror) is NEVER statically imported here —
  // it is pulled in via dynamic `import()` on first Edit, keeping it out of the
  // SSR graph. Done/Save returns to the rendered view (reusing invalidateAll).
  let editing = $state(false);
  let IslandComponent = $state<Component | null>(null);
  let islandApi = $state<WebEditorApi | null>(null);
  let islandDirty = $state(false);
  const canEdit = $derived(browser && data.user !== null && data.selected !== null);

  async function startEdit() {
    if (!IslandComponent) {
      IslandComponent = (await import('./WebEditorIsland.svelte')).default as unknown as Component;
    }
    editing = true;
  }

  /** Leave edit mode. `reRender` re-fetches the Concept for the rendered view
   *  (Done/Save on the SAME Concept); a Concept switch skips it (goto reloads). */
  function endEdit(reRender: boolean) {
    editing = false;
    islandApi = null;
    islandDirty = false;
    if (reRender) void invalidateAll();
  }

  function onToggleEdit() {
    if (!editing) void startEdit();
    else islandApi?.requestDone();
  }

  // The read-only "Sunstone Web" viewer, shaped like the desktop shell: a
  // toolbar over the CENTER tile (sidebar toggles + back/forward + theme), left
  // Sidebar Accordion (Explorer + Tags) and right Sidebar Accordion (Outline +
  // Backlinks) reusing the desktop `SidebarSection`, and the rendered Concept in
  // the centre. No write path / editor / CodeMirror. UI state persists (uiState).

  // A Concept is addressed by its path in the URL (`/research/providers/mistral-ai`),
  // not a `?path=` query — `conceptToUrl` drops `.md` and a trailing `/index`.
  function open(path: string) {
    const nav = () => void goto(conceptToUrl(path), { keepFocus: true });
    // Switching Concept while editing is an implicit exit (ticket 08 §4): route
    // it through the island's dirty gate (three-way leave modal) first.
    if (editing && islandApi) {
      islandApi.tryLeave(() => {
        endEdit(false);
        nav();
      });
      return;
    }
    nav();
  }

  // The document title is the open Concept's name (frontmatter title / H1 / path).
  const pageTitle = $derived(conceptTitle(data.selected, data.rendered));

  // Back / forward: navigation is URL-driven (`goto` pushes history), so
  // drive the browser history — SvelteKit's router handles popstate + re-runs load.
  function goBack() {
    if (typeof history !== 'undefined') history.back();
  }
  function goForward() {
    if (typeof history !== 'undefined') history.forward();
  }

  // --- Theme: applied to the app root; mode persisted via uiState. ---
  let appRoot = $state<HTMLElement | null>(null);
  $effect(() => {
    const resolved = theme.resolved;
    if (appRoot) appRoot.setAttribute('data-theme', resolved);
  });

  // --- Search (Ctrl+Shift+F) ---
  let searchOpen = $state(false);
  function openSearchHit(path: string) {
    open(path);
  }

  // --- Index-version signal for Backlinks + Tags (bumped on live-reload) ---
  let indexVersion = $state(0);

  let tags = $state<TagCount[]>([]);
  const tagsPresent = $derived(tags.length > 0);
  $effect(() => {
    void indexVersion;
    let cancelled = false;
    void backend.allTags().then((result) => {
      if (!cancelled) tags = result;
    });
    return () => {
      cancelled = true;
    };
  });

  // --- Explorer tree: expanded-folder state (all folders start collapsed, then persisted) ---
  let expandedFolders = $state(new Set<string>());
  const isExpanded = (path: string): boolean => expandedFolders.has(path);
  function setExpanded(path: string, open: boolean): void {
    const next = new Set(expandedFolders);
    if (open) next.add(path);
    else next.delete(path);
    expandedFolders = next;
  }

  const rootOrdinary = $derived(data.tree ? ordinaryChildren(data.tree) : []);
  const rootReserved = $derived(data.tree ? reservedChildren(data.tree) : []);
  const RESERVED_GLYPH: Record<ReservedKind, string> = { index: '☰', log: '🕑' };

  // --- Sidebar Accordion + whole-Sidebar collapse + Properties collapse ---
  let explorerOpen = $state(true);
  let tagsOpen = $state(true);
  let outlineOpen = $state(true);
  let backlinksOpen = $state(true);
  let leftSidebarOpen = $state(true);
  let rightSidebarOpen = $state(true);
  let propertiesOpen = $state(true);

  const leftCount = $derived((explorerOpen ? 1 : 0) + (tagsPresent && tagsOpen ? 1 : 0));
  const rightCount = $derived((outlineOpen ? 1 : 0) + (backlinksOpen ? 1 : 0));

  // Grid columns collapse a Sidebar to 0 width (the aside stays mounted + clipped
  // so its toggle can re-expand it). The right Sidebar exists only with a Concept.
  const leftCols = $derived(leftSidebarOpen ? 'minmax(200px, 260px)' : '0px');
  const rightCols = $derived(data.rendered && rightSidebarOpen ? 'minmax(13rem, 16rem)' : '0px');

  // --- Outline scroll-to-heading ---
  function scrollToHeading(slug: string) {
    document.getElementById(slug)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // --- Mermaid Diagrams (themed by `theme.resolved`) ---
  let articleEl = $state<HTMLElement | null>(null);
  $effect(() => {
    void data.rendered?.html;
    const resolved = theme.resolved;
    const el = articleEl;
    if (el) void hydrateMermaid(el, resolved);
  });

  // --- Persist UI state (localStorage) — gated until the initial load applies. ---
  let uiLoaded = false;
  function snapshot(): WebUiState {
    return {
      themeMode: theme.mode,
      expandedFolders: [...expandedFolders],
      explorerOpen,
      tagsOpen,
      outlineOpen,
      backlinksOpen,
      leftSidebarOpen,
      rightSidebarOpen,
      propertiesOpen,
    };
  }
  $effect(() => {
    const state = snapshot(); // read all deps so this re-runs on any change
    if (!uiLoaded) return; // don't clobber storage during the initial seed
    saveUiState(state);
  });

  onMount(() => {
    // The anon read surface does not mount the editor / `indexStore`, so nothing
    // else initializes wasm here. `conceptToUrl` (client navigation) reads the
    // wasm free-export holder, so load it once on mount; until it settles the
    // holder's degrade fallback keeps navigation working (ADR 0006 §5).
    void ensureWasm();

    // Signed-in users get the full App shell instead of this read surface. Done
    // in onMount (post-hydration) so SSR + first render stay the read surface.
    showApp = data.user !== null;

    // Restore persisted UI state before tracking the OS scheme.
    const ui = loadUiState();
    if (ui.themeMode) theme.mode = ui.themeMode;
    if (typeof ui.explorerOpen === 'boolean') explorerOpen = ui.explorerOpen;
    if (typeof ui.tagsOpen === 'boolean') tagsOpen = ui.tagsOpen;
    if (typeof ui.outlineOpen === 'boolean') outlineOpen = ui.outlineOpen;
    if (typeof ui.backlinksOpen === 'boolean') backlinksOpen = ui.backlinksOpen;
    if (typeof ui.leftSidebarOpen === 'boolean') leftSidebarOpen = ui.leftSidebarOpen;
    if (typeof ui.rightSidebarOpen === 'boolean') rightSidebarOpen = ui.rightSidebarOpen;
    if (typeof ui.propertiesOpen === 'boolean') propertiesOpen = ui.propertiesOpen;
    if (Array.isArray(ui.expandedFolders)) {
      expandedFolders = new Set(ui.expandedFolders);
    }
    const stopTheme = theme.start();
    uiLoaded = true;

    // Live reload (SSE): re-query Backlinks + Tags and re-render the open Concept.
    const unsubscribe = backend.onFileChanged(() => {
      indexVersion += 1;
      void invalidateAll();
    });

    // Ctrl/Cmd+Shift+F toggles the Search modal (capture phase).
    const onKeydown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchOpen = !searchOpen;
      }
    };
    window.addEventListener('keydown', onKeydown, true);

    return () => {
      stopTheme();
      unsubscribe();
      window.removeEventListener('keydown', onKeydown, true);
    };
  });
</script>

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>

{#if showApp}
  <!-- Authenticated: mount the full desktop App shell (client-only island). -->
  <WebAppShellIsland selected={data.selected} user={data.user} />
{:else}
<div class="app" data-testid="web-viewer" bind:this={appRoot}>
  <div class="app-body" style="grid-template-columns: {leftCols} minmax(0, 1fr) {rightCols}">
    <aside
      class="side-bar left"
      class:collapsed={!leftSidebarOpen}
      aria-label="Sidebar"
      style="--expanded-count: {leftCount}"
    >
      <SidebarSection
        title="Explorer"
        testid="explorer-section"
        expanded={explorerOpen}
        ontoggle={() => (explorerOpen = !explorerOpen)}
      >
        {#snippet actions()}
          {#if rootReserved.length > 0}
            <div class="root-reserved" data-testid="root-reserved">
              {#each rootReserved as r (r.path)}
                <button
                  type="button"
                  class="reserved-btn"
                  class:selected={data.selected === r.path}
                  title={`Open ${RESERVED_FILES[r.kind]} (Bundle root)`}
                  aria-label={`Open ${RESERVED_FILES[r.kind]}`}
                  data-reserved-path={r.path}
                  data-reserved-kind={r.kind}
                  onclick={() => open(r.path)}
                >{RESERVED_GLYPH[r.kind]}</button>
              {/each}
            </div>
          {/if}
        {/snippet}
        <nav class="tree" data-testid="web-tree" aria-label="Bundle">
          {#each rootOrdinary as child (child.path)}
            <WebTree node={child} selected={data.selected} onopen={open} {isExpanded} {setExpanded} />
          {/each}
        </nav>
      </SidebarSection>

      {#if tagsPresent}
        <SidebarSection
          title="Tags"
          testid="tags-section"
          expanded={tagsOpen}
          ontoggle={() => (tagsOpen = !tagsOpen)}
        >
          <WebTags {tags} version={indexVersion} selected={data.selected} onopen={open} />
        </SidebarSection>
      {/if}
    </aside>

    <div class="center">
      <!-- Concept header: mirrors the desktop TileHeader ("Concept header"). The
           left group holds the sidebar toggle, per-Concept history, and the
           Concept title; the right group the per-Concept controls (Properties
           show/hide, export, right-Sidebar). Theme follows the OS — no manual
           toggle, matching the desktop shell. -->
      <header class="tile-header" aria-label="Concept header">
        <div class="tile-title-group">
          <button
            type="button"
            class="icon-btn"
            data-testid="sidebar-toggle"
            title={leftSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-label={leftSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-pressed={leftSidebarOpen}
            onclick={() => (leftSidebarOpen = !leftSidebarOpen)}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2" />
              <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" stroke-width="1.2" />
              <rect x="1.5" y="2.5" width="4.5" height="11" rx="1.5" fill="currentColor" opacity={leftSidebarOpen ? 0.5 : 0} stroke="none" />
            </svg>
          </button>
          <!-- Per-Concept navigation history (matches the desktop TileHeader). -->
          <div class="btn-group">
            <button
              type="button"
              class="icon-btn"
              data-testid="nav-back"
              title="Back"
              aria-label="Back"
              onclick={goBack}>←</button
            >
            <button
              type="button"
              class="icon-btn"
              data-testid="nav-forward"
              title="Forward"
              aria-label="Forward"
              onclick={goForward}>→</button
            >
          </div>
          {#if data.selected}
            <span class="tile-title" data-testid="tile-title" title={data.selected}>{pageTitle}</span>
          {/if}
        </div>

        <div class="tile-controls">
          <!-- Sign-in affordance (web only): the anon read surface has no way to
               INITIATE the OIDC flow, so offer a link to the Auth.js sign-in
               page. Shown only on the web build when signed out; desktop-inert
               (dead-code-stripped via the compile-time `__SUNSTONE_WEB__`). -->
          {#if __SUNSTONE_WEB__ && data.user === null}
            <a
              class="icon-btn text-btn sign-in"
              data-testid="web-sign-in"
              href="/auth/signin"
              data-sveltekit-reload
              title="Sign in to edit"
              aria-label="Sign in">Sign in</a
            >
          {/if}
          <!-- Edit toggle (ticket 06): shown ONLY to an authenticated user with
               a Concept open. "Edit" enters the island; while editing the label
               is Save (dirty) / Done (clean) and its click flushes-then-exits. -->
          {#if canEdit}
            <button
              type="button"
              class="icon-btn text-btn edit-toggle"
              class:active={editing}
              data-testid="web-edit-toggle"
              title={editing ? 'Return to the rendered view' : 'Edit this Concept'}
              aria-label={editing ? 'Finish editing' : 'Edit this Concept'}
              aria-pressed={editing}
              onclick={onToggleEdit}>{editing ? editToggleLabel(islandDirty) : 'Edit'}</button
            >
          {/if}
          <!-- Properties show/hide (mirrors the desktop NavBar sliders toggle):
               flips the read-only Properties panel in the centre. -->
          <button
            type="button"
            class="icon-btn"
            class:active={propertiesOpen}
            data-testid="properties-panel-toggle"
            title={propertiesOpen ? 'Hide Properties' : 'Show Properties'}
            aria-label={propertiesOpen ? 'Hide Properties' : 'Show Properties'}
            aria-pressed={propertiesOpen}
            disabled={!data.rendered}
            onclick={() => (propertiesOpen = !propertiesOpen)}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <!-- sliders glyph: two horizontal rails with knobs (properties). -->
              <line x1="2.5" y1="5" x2="13.5" y2="5" stroke="currentColor" stroke-width="1.2" />
              <line x1="2.5" y1="11" x2="13.5" y2="11" stroke="currentColor" stroke-width="1.2" />
              <circle cx="6" cy="5" r="1.8" fill="var(--bg-elevated)" stroke="currentColor" stroke-width="1.2" />
              <circle cx="10.5" cy="11" r="1.8" fill="var(--bg-elevated)" stroke="currentColor" stroke-width="1.2" />
            </svg>
          </button>
          <!-- Export the open Concept as PDF: open a chrome-free print TAB
               (`/?print=<path>`) that renders just the Concept body and hands
               straight to the browser's native print → Save-as-PDF preview (its
               built-in print/download controls are the inspect-before-save UI,
               so we add none). The tab's <title> pre-fills the PDF file name. -->
          <button
            type="button"
            class="icon-btn"
            data-testid="export-pdf"
            title="Export as PDF"
            aria-label="Export as PDF"
            disabled={!data.rendered}
            onclick={() => data.selected && window.open(`/?print=${encodeURIComponent(data.selected)}`, '_blank')}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path
                d="M4 2.5h5l3 3v8a0 0 0 0 1 0 0H4a0 0 0 0 1 0 0z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linejoin="round"
              />
              <path d="M9 2.5v3h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              <path d="M8 7.5v4m0 0 1.6-1.6M8 11.5 6.4 9.9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            class="icon-btn"
            data-testid="right-sidebar-toggle"
            title={rightSidebarOpen ? 'Collapse Outline & Backlinks' : 'Expand Outline & Backlinks'}
            aria-label={rightSidebarOpen ? 'Collapse Outline & Backlinks' : 'Expand Outline & Backlinks'}
            aria-pressed={rightSidebarOpen}
            disabled={!data.rendered}
            onclick={() => (rightSidebarOpen = !rightSidebarOpen)}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2" />
              <line x1="10" y1="2.5" x2="10" y2="13.5" stroke="currentColor" stroke-width="1.2" />
              <rect x="10" y="2.5" width="4.5" height="11" rx="1.5" fill="currentColor" opacity={rightSidebarOpen ? 0.5 : 0} stroke="none" />
            </svg>
          </button>
        </div>
      </header>

      <main class="reader" class:editing aria-label="Concept">
        {#if editing}
          <!-- CENTER swapped in place for the client-only editor island. -->
          {#if IslandComponent && data.selected}
            <IslandComponent
              path={data.selected}
              onExit={() => endEdit(true)}
              onDirty={(d: boolean) => (islandDirty = d)}
              onReady={(a: WebEditorApi) => (islandApi = a)}
            />
          {:else}
            <p class="status" data-testid="reader-empty">Loading editor…</p>
          {/if}
        {:else if data.renderError}
          <p class="status error" data-testid="reader-error">
            Cannot render {data.selected}: {data.renderError}
          </p>
        {:else if data.rendered === null}
          <p class="status" data-testid="reader-empty">Select a Concept to read it.</p>
        {:else}
          {#if data.rendered.frontmatter.length > 0 && propertiesOpen}
            <!-- Read-only Properties (frontmatter); shown/hidden via the Concept
                 header's Properties toggle (mirrors the desktop global toggle). -->
            <dl class="properties" data-testid="properties">
              {#each data.rendered.frontmatter as field (field.key)}
                <dt>{field.key}</dt>
                <dd>
                  {#if field.values.length > 1}
                    <ul class="prop-list">
                      {#each field.values as v, i (i)}<li>{v}</li>{/each}
                    </ul>
                  {:else}
                    {field.values[0] ?? ''}
                  {/if}
                </dd>
              {/each}
            </dl>
          {/if}

          <!-- Server-rendered body HTML. Links resolve to viewer nav / broken
               markers in Rust; SvelteKit intercepts the in-Bundle anchors. -->
          <article class="rendered" data-testid="rendered" bind:this={articleEl}>
            {@html data.rendered.html}
          </article>
        {/if}
      </main>
    </div>

    {#if data.rendered}
      <aside
        class="side-bar right"
        class:collapsed={!rightSidebarOpen}
        aria-label="Sidebar"
        style="--expanded-count: {rightCount}"
      >
        <SidebarSection
          title="Outline"
          testid="outline-section"
          expanded={outlineOpen}
          ontoggle={() => (outlineOpen = !outlineOpen)}
        >
          <WebOutline outline={data.rendered.outline} onselect={scrollToHeading} />
        </SidebarSection>
        <SidebarSection
          title="Backlinks"
          testid="backlinks-section"
          expanded={backlinksOpen}
          ontoggle={() => (backlinksOpen = !backlinksOpen)}
        >
          <WebBacklinks path={data.selected} version={indexVersion} onopen={open} />
        </SidebarSection>
      </aside>
    {/if}
  </div>
</div>

<WebSearch open={searchOpen} onopen={openSearchHit} onclose={() => (searchOpen = false)} />
{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: var(--font-ui, system-ui, sans-serif);
    color: var(--text, #222);
    background: var(--bg, #fff);
    /* Thin, token-coloured scrollbars (Firefox/standard; inherited to all scroll
       containers within). The webkit fallback is below. */
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong, #8886) transparent;
  }

  /* WebKit/Blink scrollbar fallback — slim, rounded, token-coloured, subtle. */
  .app :global(*::-webkit-scrollbar) {
    width: 8px;
    height: 8px;
  }
  .app :global(*::-webkit-scrollbar-track) {
    background: transparent;
  }
  .app :global(*::-webkit-scrollbar-thumb) {
    background: var(--border-strong, #8886);
    border-radius: 8px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }
  .app :global(*::-webkit-scrollbar-thumb:hover) {
    background: var(--text-faint, #999);
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  .app-body {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
  }

  .side-bar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    background: var(--bg-elevated, #f9fafc);
    /* Desktop parity: the desktop sidebar steps its base down to 0.9rem
       (App.svelte `.side-bar-inner`). Without this the web sidebar rode the
       16px root and rendered larger than the desktop chrome. */
    font-size: 0.9rem;
    /* Distribute the two Sections top/bottom (desktop parity: space-between). A
       lone Section stays flush to the top. */
    justify-content: space-between;
  }

  .side-bar.left {
    grid-column: 1;
    border-right: 1px solid var(--border, #e2e2e2);
  }

  .side-bar.right {
    grid-column: 3;
    border-left: 1px solid var(--border, #e2e2e2);
  }

  /* A collapsed Sidebar is fully hidden (its grid track is also 0px). The
     component stays mounted so its toggle can re-expand it instantly. */
  .side-bar.collapsed {
    display: none;
  }

  .center {
    grid-column: 2;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  /* Concept header (mirrors the desktop TileHeader): the title group at the
     start, the per-Concept controls at the end. */
  .tile-header {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 0.4rem;
    padding: 0.3rem 0.6rem;
    border-bottom: 1px solid var(--border, #e2e2e2);
    background: var(--bg-elevated, #f9fafc);
  }

  .tile-title-group {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
    flex: 1 1 auto;
  }

  .tile-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text, #222);
  }

  .tile-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: none;
  }

  .btn-group {
    display: inline-flex;
    gap: 0.2rem;
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.7rem;
    height: 1.7rem;
    border: 1px solid var(--border, #ccc);
    border-radius: var(--radius-sm, 6px);
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;
    transition: background 0.12s ease;
  }

  .icon-btn:hover:not(:disabled) {
    background: var(--hover, rgba(127, 127, 127, 0.15));
  }

  .icon-btn.active {
    background: var(--accent, #d9622b);
    color: #fff;
    border-color: var(--accent, #d9622b);
  }

  .icon-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .root-reserved {
    display: flex;
    align-items: center;
    gap: 0.15rem;
  }

  .reserved-btn {
    width: 1.4rem;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.8rem;
    line-height: 1;
    cursor: pointer;
    border-radius: var(--radius-sm, 4px);
    opacity: 0.55;
  }

  .reserved-btn:hover {
    background: var(--hover, rgba(127, 127, 127, 0.15));
    opacity: 1;
  }

  .reserved-btn.selected {
    opacity: 1;
    background: var(--accent-soft, rgba(217, 98, 43, 0.2));
    color: var(--tag-text, inherit);
  }

  .tree {
    padding: 0.25rem 0.35rem;
    /* Match the desktop explorer tree, which hard-pins 14px (App.svelte
       `.tree-tile`). Both tree components reset with `font: inherit`, so the
       row/label size is decided here. */
    font-size: 14px;
  }

  .reader {
    flex: 1 1 auto;
    overflow: auto;
    padding: 1rem 1.5rem 4rem;
    min-width: 0;
    min-height: 0;
  }

  /* While editing, the editor island fills the centre: drop the reader padding
     + scroll (the island/CodeMirror own their own), and anchor the island's
     floating "updated" notice. */
  .reader.editing {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0;
    position: relative;
  }

  /* Text-labelled chrome buttons (Edit / Sign in): widen past the square
     icon-btn footprint to fit their word label. */
  .text-btn {
    width: auto;
    padding-inline: 0.6rem;
    font-size: 0.8rem;
    font-weight: 600;
  }

  /* Sign-in link, shaped like the edit toggle (anon web chrome). */
  .sign-in {
    text-decoration: none;
  }

  .edit-toggle.active {
    background: var(--accent-soft, rgba(217, 98, 43, 0.2));
    border-color: var(--accent, #d9622b);
    color: var(--tag-text, inherit);
  }

  /* Read-only Properties: a metadata grid (frontmatter key → value), shown/hidden
     via the Concept header's Properties toggle (desktop parity). */
  .properties {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.15rem 0.75rem;
    margin: 0 0 1.25rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--border, #e2e2e2);
    border-radius: var(--radius-sm, 6px);
    background: var(--bg-elevated, rgba(127, 127, 127, 0.06));
    font-size: 0.82rem;
  }

  .properties dt {
    font-weight: 600;
    color: var(--text-muted, #666);
  }

  .properties dd {
    margin: 0;
  }

  .prop-list {
    margin: 0;
    padding-left: 1rem;
  }

  .status {
    color: var(--text-muted, #777);
  }

  .status.error {
    color: var(--danger, #c0392b);
  }

  /* Rendered-body content styles (prose typography, links, broken-link,
     CriticMarkup marks + light/dark variants, Mermaid) live in the shared
     global stylesheet `src/lib/rendered.css`, so the print/PDF preview
     (`PrintView`) styles the SAME server-rendered HTML identically. Printing is
     now handled by the dedicated chrome-free print tab (`/?print=<path>`), not
     by printing the viewer in place, so no `@media print` chrome-hiding here. */
</style>
