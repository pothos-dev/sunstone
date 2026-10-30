<script lang="ts">
  import type { RenderPayload, TreeNode } from '$lib/types';
  import type { WebUser } from './loadConcept';
  import { onMount } from 'svelte';
  import { theme } from '$lib/state/theme.svelte';
  import WebAppShellIsland from './WebAppShellIsland.svelte';
  import WebReader from './WebReader.svelte';
  import { loadUiState } from './uiState';
  import { restoreWebViewerUiState } from './webViewerUiState';
  import { pageTitle } from './conceptUrl';
  import { pageMeta, siteName } from './seo';
  import { page } from '$app/state';

  interface Props {
    /** SSR'd data from `+page.ts`'s `load` (talks to the Rust server). */
    data: {
      bundleRoot: string;
      tree: TreeNode;
      selected: string | null;
      rendered: RenderPayload | null;
      renderError: string | null;
      /** Authenticated user (Auth.js session), or null when signed out. */
      user: WebUser | null;
    };
  }

  let { data }: Props = $props();

  // WP0: an AUTHENTICATED user gets the FULL desktop `App.svelte` shell (mounted
  // via the client-only `WebAppShellIsland`); an anonymous user gets the SSR
  // read surface (`WebReader`). The session is known SERVER-side (`data.user`
  // comes from the route `load`), so this is decided on SSR too: a signed-in
  // user's first paint is the shell's own "Loading workspace…" state rather than
  // a read surface that is then thrown away — no flash of a second surface, and
  // no hydration mismatch (SSR and the first client render read the same
  // `data.user`). Web editing happens only in that App shell.
  let showApp = $derived(data.user !== null);

  // The title the App shell reports once it drives navigation itself (its URL
  // updates are shallow, so the route `load`, and `data`, stay put).
  let appTitle = $state<string | null>(null);

  // The document title: the open Concept's frontmatter `title`, else its name,
  // then the site name. The description, canonical URL and Open Graph tags are
  // the route's Concept, for crawlers (`seo.ts`); the App shell's shallow
  // navigation only retitles the tab.
  const site = $derived(siteName(data.tree));
  const meta = $derived(
    pageMeta({
      origin: page.url.origin,
      selected: data.selected,
      rendered: data.rendered,
      pageTitle: appTitle ?? pageTitle(data.selected, data.rendered),
      siteName: site,
    }),
  );

  // The App shell keeps the theme mode chosen on the anonymous reader (its
  // light/dark toggle persists it in `sunstone:webUI`). The reader restores its
  // own UI state; the shell, which otherwise follows the OS, needs just this.
  onMount(() => {
    if (!showApp) return;
    const { themeMode } = restoreWebViewerUiState(loadUiState());
    if (themeMode) theme.mode = themeMode;
  });
</script>

<svelte:head>
  <title>{meta.title}</title>
  <meta property="og:title" content={meta.title} />
  {#if site}<meta property="og:site_name" content={site} />{/if}
  {#if meta.description}
    <meta name="description" content={meta.description} />
    <meta property="og:description" content={meta.description} />
  {/if}
  {#if meta.canonical}
    <link rel="canonical" href={meta.canonical} />
    <meta property="og:url" content={meta.canonical} />
    <meta property="og:type" content="article" />
  {/if}
</svelte:head>

{#if showApp}
  <!-- Authenticated: mount the full desktop App shell (client-only island). -->
  <WebAppShellIsland
    selected={data.selected}
    user={data.user}
    onTitle={(t) => (appTitle = t)}
  />
{:else}
  <WebReader {data} />
{/if}
