<script lang="ts">
  import type { TreeNode } from '$lib/types';
  import type { RenderPayload } from './render';
  import type { WebUser } from './loadConcept';
  import { onMount } from 'svelte';
  import { theme } from '$lib/state/theme.svelte';
  import WebAppShellIsland from './WebAppShellIsland.svelte';
  import WebReader from './WebReader.svelte';
  import { loadUiState } from './uiState';
  import { restoreWebViewerUiState } from './webViewerUiState';
  import { conceptTitle } from './conceptUrl';

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
  <WebReader {data} />
{/if}
