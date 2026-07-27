<script lang="ts">
  import type { TreeNode, TagCount } from '$lib/types';
  import type { RenderPayload } from './render';
  import type { WebUser } from './loadConcept';
  import type { Component } from 'svelte';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto, invalidateAll } from '$app/navigation';
  import { backend } from '$lib/ipc';
  import { editToggleLabel } from './concurrency';
  import type { WebEditorApi } from './WebEditorIsland.svelte';
  import { applyTheme, theme } from '$lib/state/theme.svelte';
  import { ordinaryChildren, reservedChildren } from '$lib/treeNav';
  import { RESERVED_FILES, type ReservedKind } from '$lib/reserved';
  import SidebarSection from '$lib/components/SidebarSection.svelte';
  import ActivityRail from '$lib/components/ActivityRail.svelte';
  import SidebarEdge from '$lib/components/SidebarEdge.svelte';
  import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH } from '$lib/sidebarResize';
  import WebAppShellIsland from './WebAppShellIsland.svelte';
  import WebTree from './WebTree.svelte';
  import WebSearch from './WebSearch.svelte';
  import WebQuickNav from './WebQuickNav.svelte';
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
      user: WebUser | null;
    };
  }

  let { data }: Props = $props();

  // WP0: an AUTHENTICATED user gets the FULL desktop `App.svelte` shell (mounted
  // via the client-only `WebAppShellIsland`); an anonymous user keeps this SSR
  // read surface. The session is known SERVER-side (`data.user` comes from the
  // route `load`), so this is decided on SSR too: a signed-in user's first paint
  // is the shell's own "Loading workspace…" state rather than a read surface that
  // is then thrown away — no flash of a second surface, and no hydration mismatch
  // (SSR and the first client render read the same `data.user`).
  let showApp = $derived(data.user !== null);

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

  // The read-only "Sunstone Web" viewer, shaped like the desktop shell: a far-left
  // activity rail (quick-nav + search + a bottom theme toggle + a user slot wired
  // to real Auth.js), click/drag SidebarEdge borders around a left Sidebar Accordion
  // (Explorer + Tags) and a right one (Outline + Backlinks) reusing the desktop
  // `SidebarSection`, a slim concept strip over the centre (history + Properties +
  // export-PDF), and the rendered Concept in the centre. No write path /
  // editor / CodeMirror on the anon surface. UI state persists (uiState).

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

  // The Concept the App shell has open, once it starts driving navigation itself
  // (its URL updates are shallow, so the route `load` — and `data` — stay put).
  let appConcept = $state<string | null>(null);

  // The document title is the open Concept's name (frontmatter title / H1 / path).
  // The SSR `rendered` payload only describes the SSR-selected Concept, so once
  // the shell has navigated elsewhere the title is derived from the path alone.
  const pageTitle = $derived(
    appConcept !== null && appConcept !== data.selected
      ? conceptTitle(appConcept, null)
      : conceptTitle(data.selected, data.rendered),
  );

  // Back / forward: navigation is URL-driven (`goto` pushes history), so
  // drive the browser history — SvelteKit's router handles popstate + re-runs load.
  function goBack() {
    if (typeof history !== 'undefined') history.back();
  }
  function goForward() {
    if (typeof history !== 'undefined') history.forward();
  }

  // --- Theme: applied to the app root; mode persisted via uiState. The anon web
  // surface offers a manual light/dark toggle in the activity rail (the desktop
  // shell follows the OS only — the web reader has no other theme entry point). --
  let appRoot = $state<HTMLElement | null>(null);
  $effect(() => {
    applyTheme(appRoot, theme.resolved);
  });
  function toggleTheme() {
    theme.mode = theme.resolved === 'dark' ? 'light' : 'dark';
  }

  // Sign out via the Auth.js client helper (same round-trip as the App shell's
  // account bar). A signed-in user normally gets the App shell instead of this
  // surface, so this is the fallback path (e.g. the session appearing without a
  // reload); lazy-imported so the auth client stays out of the SSR + initial
  // client graph.
  async function signOut(): Promise<void> {
    const { signOut: doSignOut } = await import('@auth/sveltekit/client');
    await doSignOut({ callbackUrl: '/' });
  }

  // --- Search (Ctrl+Shift+F) ---
  let searchOpen = $state(false);
  function openSearchHit(path: string) {
    open(path);
  }

  // --- Quick-nav palette (Ctrl/Cmd+K) ---
  let quickNavOpen = $state(false);

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

  // Sidebar content widths (px), drag-resized via the shared SidebarEdge and
  // persisted to localStorage (the web backend is read-only — no server-side
  // bundle state). Seeded to the default so the SSR render matches the first
  // client render; onMount then applies the persisted (clamped) widths.
  let leftSidebarWidth = $state(DEFAULT_SIDEBAR_WIDTH);
  let rightSidebarWidth = $state(DEFAULT_SIDEBAR_WIDTH);
  // While an edge is dragged, suppress the width transition so it tracks the
  // pointer instantly (transient — never persisted).
  let leftResizing = $state(false);
  let rightResizing = $state(false);

  const leftCount = $derived((explorerOpen ? 1 : 0) + (tagsPresent && tagsOpen ? 1 : 0));
  const rightCount = $derived((outlineOpen ? 1 : 0) + (backlinksOpen ? 1 : 0));

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
      leftSidebarWidth,
      rightSidebarWidth,
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

    // Restore persisted UI state before tracking the OS scheme.
    const ui = loadUiState();
    if (ui.themeMode) theme.mode = ui.themeMode;
    if (typeof ui.explorerOpen === 'boolean') explorerOpen = ui.explorerOpen;
    if (typeof ui.tagsOpen === 'boolean') tagsOpen = ui.tagsOpen;
    if (typeof ui.outlineOpen === 'boolean') outlineOpen = ui.outlineOpen;
    if (typeof ui.backlinksOpen === 'boolean') backlinksOpen = ui.backlinksOpen;
    if (typeof ui.leftSidebarOpen === 'boolean') leftSidebarOpen = ui.leftSidebarOpen;
    if (typeof ui.rightSidebarOpen === 'boolean') rightSidebarOpen = ui.rightSidebarOpen;
    if (typeof ui.leftSidebarWidth === 'number')
      leftSidebarWidth = clampSidebarWidth(ui.leftSidebarWidth);
    if (typeof ui.rightSidebarWidth === 'number')
      rightSidebarWidth = clampSidebarWidth(ui.rightSidebarWidth);
    if (typeof ui.propertiesOpen === 'boolean') propertiesOpen = ui.propertiesOpen;
    if (Array.isArray(ui.expandedFolders)) {
      expandedFolders = new Set(ui.expandedFolders);
    }
    const stopTheme = theme.start();
    uiLoaded = true;

    // Live reload (SSE): re-query Backlinks + Tags and re-render the open Concept.
    // READ SURFACE ONLY. Under the mounted App shell this surface is not rendered
    // and the shell is the single `onFileChanged` handler (`WebAppShellIsland`),
    // so a second subscription here would only re-run the route `load` for a
    // Concept nobody is looking at — and `invalidateAll()` RESETS `page.state`,
    // which is where the shell keeps the Concept the URL addresses.
    const unsubscribe = showApp
      ? null
      : backend.onFileChanged(() => {
          indexVersion += 1;
          void invalidateAll();
        });

    // Ctrl/Cmd+Shift+F toggles Search; Ctrl/Cmd+K toggles the quick-nav palette
    // (both capture phase, converging on the same flags the rail buttons flip).
    const onKeydown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchOpen = !searchOpen;
      } else if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'k'
      ) {
        e.preventDefault();
        quickNavOpen = !quickNavOpen;
      }
    };
    window.addEventListener('keydown', onKeydown, true);

    return () => {
      stopTheme();
      unsubscribe?.();
      window.removeEventListener('keydown', onKeydown, true);
    };
  });
</script>

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>

{#if showApp}
  <!-- Authenticated: mount the full desktop App shell (client-only island). -->
  <WebAppShellIsland
    selected={data.selected}
    user={data.user}
    onConcept={(path) => (appConcept = path)}
  />
{:else}
<div class="app" data-testid="web-viewer" bind:this={appRoot}>
  <!-- Far-left activity rail: quick-nav + search launcher + a bottom theme
       toggle and a user slot wired to the REAL Auth.js sign-in / sign-out. The
       quick-nav / search buttons flip the SAME flags as the Ctrl+K /
       Ctrl+Shift+F keybindings, so both entry points converge. The rail lives
       OUTSIDE the collapsing Sidebars, so it stays visible when they collapse. -->
  <ActivityRail
    onQuickNav={() => (quickNavOpen = !quickNavOpen)}
    onSearch={() => (searchOpen = !searchOpen)}
  >
    {#snippet bottom()}
      <!-- Manual light/dark theme toggle (web reader only), pinned to the rail
           just above the user slot. -->
      <button
        type="button"
        class="rail-user-btn"
        data-testid="theme-toggle"
        title="Toggle light / dark theme"
        aria-label="Toggle light / dark theme"
        onclick={toggleTheme}>{theme.resolved === 'dark' ? '☀' : '☾'}</button
      >
    {/snippet}
    {#snippet user()}
      <!-- The rail's bottom slot surfaces the REAL auth action. Anon (signed
           out) → a link into Auth.js sign-in (a full reload so the OIDC flow
           runs and re-lands with a session → the full App shell). If a signed-in
           user somehow renders this read surface, offer sign-out (mirrors the
           App shell's account bar). Web-only (dead-code-stripped on desktop). -->
      {#if __SUNSTONE_WEB__ && data.user === null}
        <a
          class="rail-user-btn"
          data-testid="web-sign-in"
          href="/auth/signin"
          data-sveltekit-reload
          title="Sign in to edit"
          aria-label="Sign in"
        >
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
            <circle cx="8" cy="5.5" r="2.75" fill="none" stroke="currentColor" stroke-width="1.3" />
            <path d="M2.75 13.5a5.25 5.25 0 0 1 10.5 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </a>
      {:else if data.user}
        <button
          type="button"
          class="rail-user-btn"
          data-testid="web-sign-out"
          title={`Sign out (${data.user.name})`}
          aria-label="Sign out"
          onclick={signOut}
        >
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
            <path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            <path d="M9 5l3 3-3 3M12 8H6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      {/if}
    {/snippet}
  </ActivityRail>

  <aside
    class="side-bar left"
    class:collapsed={!leftSidebarOpen}
    class:resizing={leftResizing}
    aria-label="Sidebar"
    data-testid="left-side-bar"
    style="width: {leftSidebarOpen ? leftSidebarWidth : 0}px; --side-w: {leftSidebarWidth}px; --expanded-count: {leftCount}"
  >
    <div class="side-bar-inner">
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
    </div>
  </aside>

  <!-- The left Sidebar's border: click to collapse/expand, drag to resize. -->
  <SidebarEdge
    side="left"
    open={leftSidebarOpen}
    width={leftSidebarWidth}
    label="sidebar"
    testid="left-sidebar-edge"
    onToggle={() => (leftSidebarOpen = !leftSidebarOpen)}
    onResize={(w) => (leftSidebarWidth = w)}
    onResizeStart={() => (leftResizing = true)}
    onResizeEnd={() => (leftResizing = false)}
  />

  <div class="center">
    <!-- Slim "concept strip": the web analogue of the desktop concept header
         (web has no tiles/CodeMirror, so it is light). The left group holds the
         per-Concept history + title; the right group the per-Concept controls
         (Edit for a signed-in user, Properties, export-PDF; theme lives in the
         activity rail). Sidebar collapse/resize moved to the edge borders. -->
    <div class="concept-strip" data-testid="concept-strip">
      <div class="cs-title-group">
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

      <div class="cs-controls">
        <!-- Edit toggle (ticket 06): shown ONLY to an authenticated user with a
             Concept open (inert for the anonymous reader). "Edit" enters the
             island; while editing the label is Save (dirty) / Done (clean). -->
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
        <!-- Properties show/hide: flips the read-only Properties panel in the centre. -->
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
             straight to the browser's native print → Save-as-PDF preview. -->
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
      </div>
    </div>

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
          <!-- Read-only Properties (frontmatter); shown/hidden via the concept
               strip's Properties toggle (mirrors the desktop global toggle). -->
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
    <!-- The right Sidebar's border: click to collapse/expand, drag to resize.
         Only present alongside a rendered Concept (no Outline/Backlinks without
         one). -->
    <SidebarEdge
      side="right"
      open={rightSidebarOpen}
      width={rightSidebarWidth}
      label="Outline & Backlinks"
      testid="right-sidebar-edge"
      onToggle={() => (rightSidebarOpen = !rightSidebarOpen)}
      onResize={(w) => (rightSidebarWidth = w)}
      onResizeStart={() => (rightResizing = true)}
      onResizeEnd={() => (rightResizing = false)}
    />

    <aside
      class="side-bar right"
      class:collapsed={!rightSidebarOpen}
      class:resizing={rightResizing}
      aria-label="Sidebar"
      data-testid="right-side-bar"
      style="width: {rightSidebarOpen ? rightSidebarWidth : 0}px; --side-w: {rightSidebarWidth}px; --expanded-count: {rightCount}"
    >
      <div class="side-bar-inner">
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
      </div>
    </aside>
  {/if}
</div>

<WebSearch open={searchOpen} onopen={openSearchHit} onclose={() => (searchOpen = false)} />

<WebQuickNav open={quickNavOpen} onopen={open} onclose={() => (quickNavOpen = false)} />
{/if}

<style>
  .app {
    /* Far-left activity rail (fixed) | left Sidebar | its resize edge | centre |
       right resize edge | right Sidebar. The rail and both edges sit OUTSIDE the
       collapsing Sidebars, so an edge stays a click target to re-expand a Sidebar
       collapsed to 0 (the edge border thickens) — mirrors the desktop shell grid. */
    display: grid;
    grid-template-columns: auto auto auto minmax(0, 1fr) auto auto;
    height: 100vh;
    overflow: hidden;
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

  /* A Sidebar's OUTER: its width (0 when collapsed) is driven inline from the
     persisted width; overflow-hidden clips the fixed-width inner so collapsing
     slides content out under the clip rather than reflowing it (desktop parity).
     The width transitions unless an edge drag is in progress. */
  .side-bar {
    height: 100vh;
    overflow: hidden;
    display: flex;
    background: var(--bg-elevated, #f9fafc);
    transition: width 0.22s ease;
  }

  /* Suppress the transition while dragging the edge so the width tracks the
     pointer instantly. */
  .side-bar.resizing {
    transition: none;
  }

  /* No border on the aside itself: the adjacent SidebarEdge draws the single
     1px seam (matching the rail's border). A border here too would double it. */
  .side-bar.left {
    grid-column: 2;
    justify-content: flex-end;
  }

  .side-bar.right {
    grid-column: 6;
    justify-content: flex-start;
  }

  /* The inner keeps the FULL persisted width (via --side-w) while the outer
     clips it during collapse. Distributes the two Sections top/bottom
     (space-between); a lone Section stays flush to the top. Desktop parity: the
     desktop sidebar steps its base down to 0.9rem (App.svelte `.side-bar-inner`). */
  .side-bar-inner {
    flex: none;
    width: var(--side-w, 280px);
    height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
    min-height: 0;
    font-size: 0.9rem;
  }

  .center {
    grid-column: 4;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  /* Slim concept strip: the per-Concept history + title at the start, the
     per-Concept controls at the end. */
  .concept-strip {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 0.4rem;
    padding: 0.3rem 0.6rem;
    border-bottom: 1px solid var(--border, #e2e2e2);
    background: var(--bg-elevated, #f9fafc);
  }

  .cs-title-group {
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

  .cs-controls {
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

  /* Text-labelled chrome buttons (Edit): widen past the square icon-btn footprint. */
  .text-btn {
    width: auto;
    padding-inline: 0.6rem;
    font-size: 0.8rem;
    font-weight: 600;
  }

  .edit-toggle.active {
    background: var(--accent-soft, rgba(217, 98, 43, 0.2));
    border-color: var(--accent, #d9622b);
    color: var(--tag-text, inherit);
  }

  /* Rail user slot affordance (sign-in / sign-out), sized to the rail button. */
  .rail-user-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border: none;
    border-radius: var(--radius-sm, 6px);
    background: none;
    color: var(--text-muted, #777);
    cursor: pointer;
    opacity: 0.85;
    transition: background 0.12s ease, opacity 0.12s ease;
  }

  .rail-user-btn:hover {
    background: var(--hover, rgba(127, 127, 127, 0.15));
    opacity: 1;
  }

  .rail-user-btn:focus-visible {
    outline: 2px solid var(--accent-ring, var(--accent, #d9622b));
    outline-offset: -2px;
    opacity: 1;
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
       `.tree-tile`). Both tree components reset with `font: inherit`. */
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

  /* Read-only Properties: a metadata grid (frontmatter key → value), shown/hidden
     via the concept strip's Properties toggle (desktop parity). */
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
