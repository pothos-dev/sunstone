<script lang="ts">
  import DesktopShell from '$lib/DesktopShell.svelte';
  import WebViewer from '$lib/web/WebViewer.svelte';
  import PrintView from '$lib/print/PrintView.svelte';
  import type { WebPageData } from '$lib/web/loadConcept';
  import type { PrintPageData } from '$lib/print/printData';

  // Two shells share the page routes:
  //  - the WEB build (`data.web === true`, from the route `load`) renders the
  //    read-only, SSR'd `WebViewer` over the HTTP backend;
  //  - the DEFAULT desktop/Tauri build renders the `<DesktopShell/>`, which picks
  //    the launcher or the full `<App/>` shell depending on whether a Bundle is
  //    open (see `DesktopShell`).
  // A third case cross-cuts both: the print/PDF preview (`?print=<path>`, either
  // build) renders the chrome-free `<PrintView/>` in its own window/tab.
  // In the web build `$lib/App.svelte` is aliased to an empty stub (see
  // `vite.config.js`), so the heavy editor bundle never enters the SSR web
  // build; in the desktop build `WebViewer` is present but never rendered.
  let { data }: { data: { web: false } | WebPageData | PrintPageData } = $props();
</script>

{#if 'print' in data}
  <PrintView path={data.print} toolbar={data.toolbar} />
{:else if data.web}
  <WebViewer
    data={{
      bundleRoot: data.bundleRoot,
      tree: data.tree,
      selected: data.selected,
      rendered: data.rendered,
      renderError: data.renderError,
      user: data.user,
    }}
  />
{:else}
  <DesktopShell />
{/if}
