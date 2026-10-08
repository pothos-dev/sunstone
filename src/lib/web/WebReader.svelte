<script lang="ts">
  import type { RenderPayload, TagCount, TreeNode } from '$lib/types';
  import type { WebUser } from './loadConcept';
  import { onMount } from 'svelte';
  import { bindSourceCards } from '$lib/sourceCard';
  import { goto, invalidateAll } from '$app/navigation';
  import { backend } from '$lib/ipc';
  import { applyTheme, loadAppearance, theme } from '$lib/state/theme.svelte';
  import { explorerTitle, folderNameClick, ordinaryChildren, reservedChildren } from '$lib/treeNav';
  import { RESERVED_FILES } from '$lib/reserved';
  import ReservedGlyph from '$lib/components/ReservedGlyph.svelte';
  import SidebarSection from '$lib/components/SidebarSection.svelte';
  import ActivityRail from '$lib/components/ActivityRail.svelte';
  import SidebarEdge from '$lib/components/SidebarEdge.svelte';
  import { DEFAULT_SIDEBAR_WIDTH } from '$lib/sidebarResize';
  import WebTree from './WebTree.svelte';
  import WebSearch from './WebSearch.svelte';
  import WebQuickNav from './WebQuickNav.svelte';
  import WebTags from './WebTags.svelte';
  import WebOutline from './WebOutline.svelte';
  import WebBacklinks from './WebBacklinks.svelte';
  import { hydrateMermaid } from './webMermaid';
  import { wireRemoteEmbeds } from './remoteEmbed';
  import { loadUiState, saveUiState } from './uiState';
  import { snapshotWebViewerUiState, restoreWebViewerUiState } from './webViewerUiState';
  import { matchesHotkey } from '$lib/matchesHotkey';
  import { conceptTitle } from './conceptUrl';
  import { printUrl } from '$lib/print/printData';
  import { conceptToUrl } from '$lib/wasm/exports';
  import { ensureWasm } from '$lib/wasm';
  import { escapeTarget, toggleDrawer, type Drawer } from './mobileLayout';

  /**
   * The anonymous, read-only "Sunstone Web" reader — the surface `WebViewer`
   * renders for a signed-out visitor (a signed-in user gets the full App shell
   * via `WebAppShellIsland` instead, so none of the lifecycle below runs there).
   */
  interface Props {
    /** SSR'd data from `+page.ts`'s `load` (talks to the Rust server). */
    data: {
      bundleRoot: string;
      tree: TreeNode;
      selected: string | null;
      rendered: RenderPayload | null;
      renderError: string | null;
      /** Authenticated user (Auth.js session) — always null on this surface. */
      user: WebUser | null;
    };
  }

  let { data }: Props = $props();

  // The read-only "Sunstone Web" viewer, shaped like the desktop shell: a far-left
  // activity rail (quick-nav + search + a bottom theme toggle + a user slot wired
  // to real Auth.js), click/drag SidebarEdge borders around a left Sidebar Accordion
  // (Explorer + Tags) and a right one (Outline + Backlinks) reusing the desktop
  // `SidebarSection`, a slim concept strip over the centre (title + Properties +
  // export-PDF; Back/Forward is the browser's own), and the rendered Concept in the centre. No write path /
  // editor / CodeMirror on the anon surface. UI state persists (uiState).

  // A Concept is addressed by its path in the URL (`/research/providers/mistral-ai`),
  // not a `?path=` query — `conceptToUrl` drops `.md` and a trailing `/index`.
  function open(path: string) {
    drawer = null;
    void goto(conceptToUrl(path), { keepFocus: true });
  }

  // --- Narrow-screen (phone) layout: below the breakpoint both Sidebars are
  // slide-over drawers and the rails' controls move into the concept strip + an
  // overflow menu. The switch is CSS-only; this is just the transient drawer /
  // menu state (never persisted — see `mobileLayout.ts`). Opening a Concept or
  // jumping to a heading closes the drawer so the Concept is what you see. ---
  let drawer = $state<Drawer>(null);
  let menuOpen = $state(false);

  // The concept strip's title (the same name `WebViewer` puts in `<title>`).
  const pageTitle = $derived(conceptTitle(data.selected, data.rendered));

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
  // The root index.md opens from the Explorer header title, so only the other
  // reserved files keep a header icon (mirrors the desktop App).
  const rootReserved = $derived(
    data.tree ? reservedChildren(data.tree).filter((r) => r.kind !== 'index') : [],
  );

  function onExplorerTitleClick() {
    const action = data.tree ? folderNameClick(data.tree, data.selected) : 'toggle';
    if (action === 'toggle') ui.explorerOpen = !ui.explorerOpen;
    else open(action.open);
  }

  // --- Persisted UI state: Sidebar Accordion, whole-Sidebar collapse,
  // Properties collapse and the Sidebar content widths (px, drag-resized via the
  // shared SidebarEdge). Persisted to localStorage (the web backend is read-only
  // — no server-side bundle state) together with the theme mode and
  // `expandedFolders`. Seeded to the defaults so the SSR render matches the
  // first client render; onMount then applies the persisted (validated,
  // clamped) values.
  const ui = $state({
    explorerOpen: true,
    tagsOpen: true,
    outlineOpen: true,
    backlinksOpen: true,
    leftSidebarOpen: true,
    rightSidebarOpen: true,
    propertiesOpen: true,
    leftSidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    rightSidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  });
  // While an edge is dragged, suppress the width transition so it tracks the
  // pointer instantly (transient — never persisted).
  let leftResizing = $state(false);
  let rightResizing = $state(false);

  const leftCount = $derived((ui.explorerOpen ? 1 : 0) + (tagsPresent && ui.tagsOpen ? 1 : 0));
  const rightCount = $derived((ui.outlineOpen ? 1 : 0) + (ui.backlinksOpen ? 1 : 0));

  // --- Outline scroll-to-heading ---
  function scrollToHeading(slug: string) {
    drawer = null;
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

  // --- Remote Embeds: click-to-load (af-1) ---
  // The renderer withholds a remote image's `src` so opening a Concept fetches
  // nothing; this turns the placeholder into a real <img> on click.
  $effect(() => {
    const el = articleEl;
    if (!el) return;
    return wireRemoteEmbeds(el);
  });

  // --- Source hover cards (ov-17) ---
  // Footnotes citing a `sources` entry and the Sources section titles carry
  // their entry as `data-source`; one delegated binding shows the card.
  $effect(() => {
    const el = articleEl;
    if (!el) return;
    return bindSourceCards(el);
  });

  // --- Persist UI state (localStorage) — gated until the initial load applies. ---
  let uiLoaded = $state(false);
  $effect(() => {
    // read all deps (spreading `ui` reads every field) so this re-runs on any change
    const state = snapshotWebViewerUiState({ ...ui, themeMode: theme.mode, expandedFolders });
    if (!uiLoaded) return; // don't clobber storage during the initial seed
    saveUiState(state);
  });

  onMount(() => {
    // The anon read surface does not mount the editor / `indexStore`, so nothing
    // else initializes wasm here. `conceptToUrl` (client navigation) reads the
    // wasm free-export holder, so load it once on mount; until it settles the
    // holder's degrade fallback keeps navigation working (ADR 0006 §5).
    void ensureWasm();
    // Swap the SSR-inlined colour/font overrides for the browser-validated copy.
    void loadAppearance(backend);

    // Restore persisted UI state before tracking the OS scheme.
    const {
      themeMode,
      expandedFolders: restoredFolders,
      ...restored
    } = restoreWebViewerUiState(loadUiState());
    if (themeMode) theme.mode = themeMode;
    if (restoredFolders) expandedFolders = restoredFolders;
    Object.assign(ui, restored);
    const stopTheme = theme.start();
    uiLoaded = true;

    // Live reload (SSE): re-query Backlinks + Tags and re-render the open Concept.
    // This surface never mounts under the App shell, whose `WebAppShellIsland` is
    // then the single `onFileChanged` handler (a second one would re-run the
    // route `load` — and `invalidateAll()` RESETS `page.state`, where the shell
    // keeps the Concept the URL addresses).
    const unsubscribe = backend.onFileChanged(() => {
      indexVersion += 1;
      void invalidateAll();
    });

    // Ctrl/Cmd+Shift+F toggles Search; Ctrl/Cmd+K toggles the quick-nav palette
    // (both capture phase, converging on the same flags the rail buttons flip).
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const target = escapeTarget({ dialogOpen: searchOpen || quickNavOpen, menuOpen, drawer });
        if (target === 'menu') menuOpen = false;
        else if (target === 'drawer') drawer = null;
        if (target !== null) e.preventDefault();
      } else if (matchesHotkey(e, { key: 'f', shift: true })) {
        e.preventDefault();
        searchOpen = !searchOpen;
      } else if (matchesHotkey(e, { key: 'k' })) {
        e.preventDefault();
        quickNavOpen = !quickNavOpen;
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

<div class="app" data-testid="web-viewer" bind:this={appRoot}>
  <!-- Left activity rail: the left Sidebar's collapse toggle at the top, then
       quick-nav + search launcher, plus a bottom theme toggle and a user slot
       wired to the REAL Auth.js sign-in / sign-out. The quick-nav / search
       buttons flip the SAME flags as the Ctrl+K / Ctrl+Shift+F keybindings, so
       both entry points converge. The rail lives OUTSIDE the collapsing
       Sidebars, so it stays visible when they collapse — which is what lets a
       Sidebar go all the way to 0 width. -->
  <ActivityRail
    side="left"
    sidebarOpen={ui.leftSidebarOpen}
    sidebarLabel="sidebar"
    toggleTestid="rail-toggle-left"
    onToggleSidebar={() => (ui.leftSidebarOpen = !ui.leftSidebarOpen)}
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
      <!-- The rail's bottom slot surfaces the REAL auth action: a link into
           Auth.js sign-in (a full reload so the OIDC flow runs and re-lands
           with a session → the full App shell). This surface only renders for
           `data.user === null`. Web-only (dead-code-stripped on desktop). -->
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
      {/if}
    {/snippet}
  </ActivityRail>

  <aside
    class="side-bar left"
    class:collapsed={!ui.leftSidebarOpen}
    class:resizing={leftResizing}
    class:drawer-open={drawer === 'left'}
    aria-label="Sidebar"
    data-testid="left-side-bar"
    style="--open-w: {ui.leftSidebarOpen ? ui.leftSidebarWidth : 0}px; --side-w: {ui.leftSidebarWidth}px; --expanded-count: {leftCount}"
  >
    <div class="side-bar-inner">
      <SidebarSection
        title={explorerTitle(data.tree)}
        testid="explorer-section"
        expanded={ui.explorerOpen}
        ontoggle={() => (ui.explorerOpen = !ui.explorerOpen)}
        ontitleclick={onExplorerTitleClick}
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
                ><ReservedGlyph kind={r.kind} /></button>
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
          expanded={ui.tagsOpen}
          ontoggle={() => (ui.tagsOpen = !ui.tagsOpen)}
        >
          <WebTags {tags} version={indexVersion} selected={data.selected} onopen={open} />
        </SidebarSection>
      {/if}
    </div>
  </aside>

  <!-- The left Sidebar's border: drag to resize. Collapsing lives on the rail's
       toggle button, so the border is absent while the Sidebar is collapsed. -->
  <div class="edge-slot left-edge-slot">
    {#if ui.leftSidebarOpen}
      <SidebarEdge
        side="left"
        width={ui.leftSidebarWidth}
        label="sidebar"
        testid="left-sidebar-edge"
        onResize={(w) => (ui.leftSidebarWidth = w)}
        onResizeStart={() => (leftResizing = true)}
        onResizeEnd={() => (leftResizing = false)}
      />
    {/if}
  </div>

  <div class="center">
    <!-- Slim "concept strip": the web analogue of the desktop concept header
         (web has no tiles/CodeMirror, so it is light). The left group holds the
         title; the right group the per-Concept controls
         (Properties, export-PDF; theme lives in the activity rail). Sidebar
         collapse/resize moved to the edge borders. -->
    <div class="concept-strip" data-testid="concept-strip">
      <div class="cs-title-group">
        <!-- Narrow screens only: the Explorer drawer (the left rail is hidden). -->
        <button
          type="button"
          class="icon-btn narrow-only"
          class:active={drawer === 'left'}
          data-testid="drawer-toggle-left"
          title="Explorer"
          aria-label="Explorer"
          aria-expanded={drawer === 'left'}
          onclick={() => {
            menuOpen = false;
            drawer = toggleDrawer(drawer, 'left');
          }}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M2.5 4h11M2.5 8h11M2.5 12h11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
        {#if data.selected}
          <span class="tile-title" data-testid="tile-title" title={data.selected}>{pageTitle}</span>
        {/if}
      </div>

      <div class="cs-controls">
        <!-- Properties show/hide: flips the read-only Properties panel in the centre. -->
        <button
          type="button"
          class="icon-btn wide-only"
          class:active={ui.propertiesOpen}
          data-testid="properties-panel-toggle"
          title={ui.propertiesOpen ? 'Hide Properties' : 'Show Properties'}
          aria-label={ui.propertiesOpen ? 'Hide Properties' : 'Show Properties'}
          aria-pressed={ui.propertiesOpen}
          disabled={!data.rendered}
          onclick={() => (ui.propertiesOpen = !ui.propertiesOpen)}
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
          class="icon-btn wide-only"
          data-testid="export-pdf"
          title="Export as PDF"
          aria-label="Export as PDF"
          disabled={!data.rendered}
          onclick={() => data.selected && window.open(printUrl(data.selected), '_blank')}
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

        <!-- Narrow screens only: quick nav, the Outline & Backlinks drawer and an
             overflow menu stand in for the hidden rails + the controls above. -->
        <button
          type="button"
          class="icon-btn narrow-only"
          data-testid="strip-quicknav"
          title="Quick nav"
          aria-label="Quick nav"
          onclick={() => {
            drawer = null;
            menuOpen = false;
            quickNavOpen = true;
          }}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" stroke-width="1.3" />
            <path d="m10.2 10.2 3.3 3.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
        {#if data.rendered}
          <button
            type="button"
            class="icon-btn narrow-only"
            class:active={drawer === 'right'}
            data-testid="drawer-toggle-right"
            title="Outline & Backlinks"
            aria-label="Outline & Backlinks"
            aria-expanded={drawer === 'right'}
            onclick={() => {
              menuOpen = false;
              drawer = toggleDrawer(drawer, 'right');
            }}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path d="M2.5 4h11M5 8h8.5M7.5 12h6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
        {/if}
        <div class="menu-anchor narrow-only">
          <button
            type="button"
            class="icon-btn"
            class:active={menuOpen}
            data-testid="strip-menu"
            title="More"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onclick={() => {
              drawer = null;
              menuOpen = !menuOpen;
            }}
          >⋯</button>
          {#if menuOpen}
            <div class="strip-menu" role="menu" data-testid="strip-menu-list">
              <button
                type="button"
                role="menuitem"
                data-testid="menu-search"
                onclick={() => {
                  menuOpen = false;
                  searchOpen = true;
                }}>Search in Bundle</button
              >
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={ui.propertiesOpen}
                data-testid="menu-properties"
                disabled={!data.rendered}
                onclick={() => {
                  menuOpen = false;
                  ui.propertiesOpen = !ui.propertiesOpen;
                }}>{ui.propertiesOpen ? 'Hide Properties' : 'Show Properties'}</button
              >
              <button
                type="button"
                role="menuitem"
                data-testid="menu-export-pdf"
                disabled={!data.rendered}
                onclick={() => {
                  menuOpen = false;
                  if (data.selected) window.open(printUrl(data.selected), '_blank');
                }}>Export as PDF</button
              >
              <button
                type="button"
                role="menuitem"
                data-testid="menu-theme"
                onclick={() => {
                  menuOpen = false;
                  toggleTheme();
                }}>{theme.resolved === 'dark' ? 'Light theme' : 'Dark theme'}</button
              >
              {#if __SUNSTONE_WEB__ && data.user === null}
                <a role="menuitem" href="/auth/signin" data-sveltekit-reload data-testid="menu-sign-in">Sign in</a>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>

    <main class="reader" aria-label="Concept">
      {#if data.renderError}
        <p class="status error" data-testid="reader-error">
          {data.renderError}
        </p>
      {:else if data.rendered === null}
        <p class="status" data-testid="reader-empty">Select a Concept to read it.</p>
      {:else}
        {#if data.rendered.frontmatter.length > 0 && ui.propertiesOpen}
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
    <!-- The right Sidebar's border: drag to resize. Only present alongside a
         rendered Concept (no Outline/Backlinks without one), and only while the
         Sidebar is expanded — the right rail's toggle owns collapse/expand. -->
    <div class="edge-slot right-edge-slot">
      {#if ui.rightSidebarOpen}
        <SidebarEdge
          side="right"
          width={ui.rightSidebarWidth}
          label="Outline & Backlinks"
          testid="right-sidebar-edge"
          onResize={(w) => (ui.rightSidebarWidth = w)}
          onResizeStart={() => (rightResizing = true)}
          onResizeEnd={() => (rightResizing = false)}
        />
      {/if}
    </div>

    <aside
      class="side-bar right"
      class:collapsed={!ui.rightSidebarOpen}
      class:resizing={rightResizing}
      class:drawer-open={drawer === 'right'}
      aria-label="Sidebar"
      data-testid="right-side-bar"
      style="--open-w: {ui.rightSidebarOpen ? ui.rightSidebarWidth : 0}px; --side-w: {ui.rightSidebarWidth}px; --expanded-count: {rightCount}"
    >
      <div class="side-bar-inner">
        <SidebarSection
          title="Outline"
          testid="outline-section"
          expanded={ui.outlineOpen}
          ontoggle={() => (ui.outlineOpen = !ui.outlineOpen)}
        >
          <WebOutline outline={data.rendered.outline} onselect={scrollToHeading} />
        </SidebarSection>
        <SidebarSection
          title="Backlinks"
          testid="backlinks-section"
          expanded={ui.backlinksOpen}
          ontoggle={() => (ui.backlinksOpen = !ui.backlinksOpen)}
        >
          <WebBacklinks path={data.selected} version={indexVersion} onopen={open} />
        </SidebarSection>
      </div>
    </aside>

    <ActivityRail
      side="right"
      sidebarOpen={ui.rightSidebarOpen}
      sidebarLabel="Outline & Backlinks"
      toggleTestid="rail-toggle-right"
      onToggleSidebar={() => (ui.rightSidebarOpen = !ui.rightSidebarOpen)}
    />
  {/if}
  <!-- Tap-to-close scrim behind an open drawer / the overflow menu (only ever
       shown on narrow screens; the CSS hides it otherwise). -->
  {#if drawer !== null || menuOpen}
    <div
      class="drawer-scrim"
      class:clear={drawer === null}
      role="presentation"
      data-testid="drawer-scrim"
      onclick={() => {
        drawer = null;
        menuOpen = false;
      }}
    ></div>
  {/if}
</div>

<WebSearch open={searchOpen} onopen={openSearchHit} onclose={() => (searchOpen = false)} />

<WebQuickNav
  open={quickNavOpen}
  version={indexVersion}
  onopen={open}
  onclose={() => (quickNavOpen = false)}
/>

<style>
  .app {
    /* Left activity rail | left Sidebar | its resize edge | centre | right resize
       edge | right Sidebar | right activity rail. Both rails sit OUTSIDE the
       collapsing Sidebars and stay visible, so a Sidebar collapses to a true 0
       width and its rail toggle is the way back — mirrors the desktop shell
       grid. Each edge slot is empty while its Sidebar is collapsed. */
    display: grid;
    grid-template-columns: auto auto auto minmax(0, 1fr) auto auto auto;
    /* `dvh` tracks a mobile browser's collapsing toolbars (plain `vh` is the
       LARGEST viewport, so the bottom of the rail sat under the toolbar). */
    height: 100vh;
    height: 100dvh;
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

  /* A Sidebar's OUTER: its width (0 when collapsed) is driven inline (`--open-w`)
     from the persisted width; overflow-hidden clips the fixed-width inner so collapsing
     slides content out under the clip rather than reflowing it (desktop parity).
     The width transitions unless an edge drag is in progress. */
  .side-bar {
    width: var(--open-w);
    height: 100vh;
    height: 100dvh;
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

  /* The rails are components, so pin their columns from here (everything else
     in the shell grid is explicitly placed; leaving these to auto-placement
     would make the layout depend on child order). */
  .app > :global(.activity-rail.left) {
    grid-column: 1;
  }

  .app > :global(.activity-rail.right) {
    grid-column: 7;
  }

  /* A stable grid column for a Sidebar's resize edge. The edge is rendered only
     while its Sidebar is expanded; the slot holds the column open either way. */
  .edge-slot {
    display: flex;
    height: 100vh;
    height: 100dvh;
  }

  .left-edge-slot {
    grid-column: 3;
  }

  .right-edge-slot {
    grid-column: 5;
  }

  /* The inner keeps the FULL persisted width (via --side-w) while the outer
     clips it during collapse. Distributes the two Sections top/bottom
     (space-between); a lone Section stays flush to the top. Desktop parity: the
     desktop sidebar steps its base down to 0.9rem (App.svelte `.side-bar-inner`). */
  .side-bar-inner {
    flex: none;
    width: var(--side-w, 280px);
    height: 100vh;
    height: 100dvh;
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

  /* Slim concept strip: the title at the start, the
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

  /* Rail user slot affordance (sign-in / sign-out), sized to the rail button. */
  .rail-user-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
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
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    padding: 0;
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
    /* Same size as the rendered Concept body, like the desktop explorer
       (`ExplorerPane.svelte` `.tree-tile`). Both tree components reset with
       `font: inherit`. */
    font-size: var(--rendered-body-size, 14px);
    font-family: var(--font-content, inherit);
  }

  .reader {
    flex: 1 1 auto;
    overflow: auto;
    padding: 1rem 1.5rem 4rem;
    min-width: 0;
    min-height: 0;
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

  /* --- Narrow-screen controls (see `mobileLayout.ts`). Hidden on wide screens;
     the `@media` block below swaps them in for the rails + wide-only buttons. --- */
  .narrow-only,
  .drawer-scrim {
    display: none;
  }

  .menu-anchor {
    position: relative;
  }

  .strip-menu {
    position: absolute;
    top: calc(100% + 0.35rem);
    right: 0;
    z-index: 1100;
    display: flex;
    flex-direction: column;
    min-width: 12rem;
    padding: 0.3rem;
    border: 1px solid var(--border, #ccc);
    border-radius: var(--radius-lg, 10px);
    background: var(--bg-elevated, #fff);
    box-shadow: var(--shadow-lg, 0 10px 40px rgba(0, 0, 0, 0.2));
  }

  .strip-menu > button,
  .strip-menu > a {
    display: flex;
    align-items: center;
    min-height: 2.75rem;
    padding: 0 0.75rem;
    border: none;
    border-radius: var(--radius-sm, 6px);
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.95rem;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
  }

  .strip-menu > button:hover:not(:disabled),
  .strip-menu > a:hover {
    background: var(--hover, rgba(127, 127, 127, 0.15));
  }

  .strip-menu > button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Phones / narrow windows: one column for the Concept. The Sidebars leave the
     grid and become slide-over drawers, the rails and resize edges go, and the
     rails' controls live in the concept strip (☰ / quick nav / ≡ / ⋯). Keep the
     breakpoint in step with `NARROW_MAX_WIDTH` (`mobileLayout.ts`). */
  @media (max-width: 768px) {
    .app {
      grid-template-columns: minmax(0, 1fr);
    }

    .app > :global(.activity-rail),
    .edge-slot,
    .wide-only {
      display: none;
    }

    .narrow-only {
      display: inline-flex;
    }

    .center {
      grid-column: 1;
      grid-row: 1;
    }

    .side-bar,
    .side-bar.resizing {
      position: fixed;
      top: 0;
      bottom: 0;
      z-index: 1000;
      width: min(85vw, 320px);
      box-shadow: var(--shadow-lg, 0 10px 40px rgba(0, 0, 0, 0.2));
      visibility: hidden;
      transition:
        transform 0.22s ease,
        visibility 0s linear 0.22s;
    }

    .side-bar.left {
      left: 0;
      transform: translateX(-100%);
      border-right: 1px solid var(--border, #e2e2e2);
    }

    .side-bar.right {
      right: 0;
      transform: translateX(100%);
      border-left: 1px solid var(--border, #e2e2e2);
    }

    .side-bar.drawer-open {
      transform: none;
      visibility: visible;
      transition: transform 0.22s ease;
    }

    .side-bar-inner {
      width: 100%;
    }

    .drawer-scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 999;
      background: rgba(16, 22, 18, 0.4);
    }

    /* The overflow menu's scrim only catches the outside tap; no dimming. */
    .drawer-scrim.clear {
      background: transparent;
    }

    .concept-strip {
      padding: 0.35rem 0.5rem;
      padding-top: max(0.35rem, env(safe-area-inset-top));
    }

    .cs-controls {
      gap: 0.3rem;
    }

    .reader {
      padding: 0.75rem 1rem 3rem;
      padding-bottom: max(3rem, env(safe-area-inset-bottom));
    }

    /* Long URLs / ids wrap instead of widening the page; a wide table scrolls
       inside its own box instead of scrolling the whole reader sideways. */
    .reader :global(.rendered) {
      overflow-wrap: break-word;
    }

    .reader :global(.rendered table) {
      display: block;
      max-width: 100%;
      overflow-x: auto;
    }
  }

  /* Touch: finger-sized targets (~40px) for the strip buttons and the Sidebar
     lists. */
  @media (pointer: coarse) {
    .icon-btn {
      width: 2.5rem;
      height: 2.5rem;
    }

    .app :global(.tree .row),
    .app :global(.side-bar .entry) {
      min-height: 2.25rem;
    }

    .app :global(.tree .caret-col) {
      width: 2rem;
    }
  }

  /* Rendered-body content styles (prose typography, links, broken-link,
     CriticMarkup marks + light/dark variants, Mermaid) live in the shared
     global stylesheet `src/lib/rendered.css`, so the print/PDF preview
     (`PrintView`) styles the SAME server-rendered HTML identically. Printing is
     now handled by the dedicated chrome-free print tab (`/?print=<path>`), not
     by printing the viewer in place, so no `@media print` chrome-hiding here. */
</style>
