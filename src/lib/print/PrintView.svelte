<script lang="ts">
  import { onMount } from 'svelte';
  import { backend } from '$lib/ipc';
  import { createLatestGuard } from '$lib/asyncGuard';
  import type { RenderPayload } from '$lib/types';
  import { hydrateMermaid } from '$lib/web/webMermaid';
  import { conceptTitle } from '$lib/web/conceptUrl';

  // Chrome-free print/PDF preview of a single Concept, opened in its OWN
  // window/tab (never inside the app shell). Two modes:
  //
  //  - `toolbar = false` (web): a bare tab rendering just the Concept body. It
  //    auto-invokes `window.print()` once ready, so the BROWSER's native print
  //    → Save-as-PDF preview is the inspection surface (it already carries
  //    print/save controls, so we add none).
  //  - `toolbar = true` (desktop, opened as a separate Tauri window): the same
  //    body under a small toolbar offering Print / Save-as-PDF plus font-size
  //    and margin controls — WebKitGTK has no rich PDF chrome of its own.
  //
  // Both render the SAME server-quality HTML via `backend.renderConcept` and
  // reuse the shared `rendered.css`, so the printed page matches the web viewer.

  interface Props {
    path: string;
    toolbar: boolean;
  }
  let { path, toolbar }: Props = $props();

  let bodyEl = $state<HTMLElement | null>(null);
  let surfaceEl = $state<HTMLElement | null>(null);
  let error = $state<string | null>(null);
  let ready = $state(false);

  // The Concept currently shown: the `path` prop until an in-Bundle link is
  // followed inside the preview, which sets `navigatedPath` (see `followLinks`)
  // so the link opens IN the print preview rather than escaping to the app shell.
  let navigatedPath = $state<string | null>(null);
  const currentPath = $derived(navigatedPath ?? path);
  // Guards against a slow render for an earlier Concept clobbering a later one
  // when links are clicked in quick succession.
  const renderGuard = createLatestGuard();
  // Auto-print (web bare tab) must fire on the FIRST render only, not on every
  // in-preview navigation.
  let firstRender = true;

  // --- Reader controls (toolbar mode only) --------------------------------
  // Font size scales the whole rendered body; margins drive BOTH the on-screen
  // paper padding and the real `@page` margin at print time (injected below).
  let fontSize = $state(16); // px
  const MARGINS = { narrow: '10mm', normal: '18mm', wide: '25mm' } as const;
  type MarginKey = keyof typeof MARGINS;
  let margin = $state<MarginKey>('normal');
  const marginValue = $derived(MARGINS[margin]);

  // Optional on-screen page-break guides: dashed lines every A4 content-page
  // height (297mm minus top+bottom margin), aligned to the content box. An
  // approximation — real pagination also honours the break-avoid rules below —
  // but close enough to see roughly where pages will turn.
  let pageGuides = $state(false);
  const PAGE_HEIGHTS = { narrow: '277mm', normal: '261mm', wide: '247mm' } as const;
  const pageHeight = $derived(PAGE_HEIGHTS[margin]);

  // Reactive `@page { margin }` — @page can't read CSS custom props, so we keep
  // a live stylesheet element in sync with the chosen margin.
  let pageStyleEl: HTMLStyleElement | null = null;
  $effect(() => {
    const m = marginValue;
    if (!pageStyleEl) {
      pageStyleEl = document.createElement('style');
      document.head.appendChild(pageStyleEl);
    }
    pageStyleEl.textContent = `@page { margin: ${m}; }`;
  });

  // Render `currentPath` into the body. Re-runs whenever an in-Bundle link
  // re-points `currentPath` (the whole point: links open IN the preview). A
  // per-run token means a superseded render never writes its stale HTML.
  $effect(() => {
    const p = currentPath;
    const token = renderGuard.next();
    ready = false;
    error = null;
    void (async () => {
      let payload: RenderPayload;
      try {
        payload = await backend.renderConcept(p);
      } catch (e) {
        if (renderGuard.isLatest(token)) error = e instanceof Error ? e.message : String(e);
        return;
      }
      if (!renderGuard.isLatest(token) || !bodyEl) return;
      bodyEl.innerHTML = payload.html;
      // Force light Mermaid — dark diagrams read wrong / waste ink on paper.
      await hydrateMermaid(bodyEl, 'light');
      if (!renderGuard.isLatest(token)) return;
      if (surfaceEl) surfaceEl.scrollTop = 0; // a followed link starts at the top
      // Name the window/tab after the Concept so the saved PDF is sensibly named.
      document.title = conceptTitle(p, payload);
      ready = true;
      // Web tab: hand straight to the browser's print → Save-as-PDF preview
      // (initial load only — not on every in-preview navigation).
      if (!toolbar && firstRender) window.print();
      firstRender = false;
    })();
  });

  onMount(() => () => {
    pageStyleEl?.remove();
    pageStyleEl = null;
  });

  // The rendered body carries `<a class="internal-link" data-path=…>` for
  // in-Bundle links (resolved in Rust). Their `href` is the app's pretty URL, so
  // a plain click would let the router escape the preview to the normal shell.
  // Delegate a listener on the body to intercept them and re-point
  // `navigatedPath` instead, keeping navigation inside the print preview. Broken
  // links have no target; external / anchor links keep their default behaviour.
  $effect(() => {
    const el = bodyEl;
    if (!el) return;
    const followLinks = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor || !anchor.classList.contains('internal-link')) return;
      e.preventDefault();
      if (anchor.dataset.broken) return;
      const dest = anchor.dataset.path;
      if (dest) navigatedPath = dest;
    };
    el.addEventListener('click', followLinks);
    return () => el.removeEventListener('click', followLinks);
  });

  function decFont() {
    fontSize = Math.max(10, fontSize - 1);
  }
  function incFont() {
    fontSize = Math.min(28, fontSize + 1);
  }

  // Direct Save-as-PDF: write a PDF file straight from this window, skipping the
  // OS print dialog (native save chooser + WebKitGTK export, in Rust). Falls
  // back to the print dialog on platforms without direct export.
  let saving = $state(false);
  let savedMsg = $state<string | null>(null);
  async function savePdf() {
    if (saving || !ready) return;
    saving = true;
    savedMsg = null;
    try {
      const saved = await backend.savePdf(`${document.title}.pdf`);
      if (saved) savedMsg = `Saved to ${saved}`;
    } catch {
      window.print(); // no direct export here — use the print dialog instead
    } finally {
      saving = false;
    }
  }
</script>

<svelte:head>
  <title>Print — Sunstone</title>
</svelte:head>

<div class="print-view" data-testid="print-view" data-toolbar={toolbar ? '1' : '0'}>
  {#if toolbar}
    <nav class="print-toolbar" aria-label="Print controls">
      <button
        type="button"
        class="pt-btn primary"
        data-testid="save-pdf"
        disabled={!ready || saving}
        onclick={savePdf}
      >{saving ? 'Saving…' : 'Save as PDF'}</button>
      <button
        type="button"
        class="pt-btn"
        data-testid="print-action"
        disabled={!ready}
        onclick={() => window.print()}
      >Print…</button>

      <div class="pt-group" aria-label="Font size">
        <span class="pt-label">Font</span>
        <button type="button" class="pt-btn" data-testid="font-dec" aria-label="Smaller font" onclick={decFont}>A−</button>
        <span class="pt-value" data-testid="font-size">{fontSize}px</span>
        <button type="button" class="pt-btn" data-testid="font-inc" aria-label="Larger font" onclick={incFont}>A+</button>
      </div>

      <div class="pt-group" aria-label="Margins">
        <span class="pt-label">Margins</span>
        <select class="pt-select" data-testid="margin-select" bind:value={margin} aria-label="Page margins">
          <option value="narrow">Narrow</option>
          <option value="normal">Normal</option>
          <option value="wide">Wide</option>
        </select>
      </div>

      <label class="pt-group pt-toggle">
        <input type="checkbox" data-testid="page-guides" bind:checked={pageGuides} />
        <span class="pt-label">Page guides</span>
      </label>

      {#if savedMsg}
        <span class="pt-saved" data-testid="save-status">{savedMsg}</span>
      {/if}
    </nav>
  {/if}

  <div class="print-surface" bind:this={surfaceEl}>
    {#if error}
      <p class="print-error" data-testid="print-error">Cannot render {currentPath}: {error}</p>
    {/if}
    <!-- Always mounted so the render effect can write into it across in-preview
         navigation; hidden (not unmounted) while an error is shown. Link clicks
         are handled by a delegated listener wired in `followLinks` (below). -->
    <article
      class="print-page rendered"
      class:page-guides={pageGuides}
      data-testid="print-body"
      hidden={!!error}
      style="font-size: {fontSize}px; padding: {marginValue}; --page-height: {pageHeight};"
      bind:this={bodyEl}
    ></article>
  </div>
</div>

<style>
  .print-view {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg-sunken, #eceef1);
    color: var(--text, #222);
    font-family: var(--font-ui, system-ui, sans-serif);
  }

  .print-toolbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 1.25rem;
    padding: 0.5rem 0.9rem;
    background: var(--bg-elevated, #f9fafc);
    border-bottom: 1px solid var(--border, #e2e2e2);
  }

  .pt-group {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .pt-label {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-muted, #777);
  }

  .pt-value {
    font-variant-numeric: tabular-nums;
    font-size: 0.82rem;
    min-width: 2.6rem;
    text-align: center;
    color: var(--text-muted, #555);
  }

  .pt-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.9rem;
    height: 1.9rem;
    padding: 0 0.6rem;
    border: 1px solid var(--border, #ccc);
    border-radius: var(--radius-sm, 6px);
    background: var(--bg, #fff);
    color: inherit;
    font: inherit;
    font-size: 0.85rem;
    line-height: 1;
    cursor: pointer;
    transition: background 0.12s ease;
  }

  .pt-btn:hover:not(:disabled) {
    background: var(--hover, rgba(127, 127, 127, 0.15));
  }

  .pt-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .pt-btn.primary {
    font-weight: 600;
    background: var(--accent, #1a3a6b);
    color: #fff;
    border-color: transparent;
  }

  .pt-btn.primary:hover:not(:disabled) {
    filter: brightness(1.08);
  }

  .pt-saved {
    font-size: 0.8rem;
    color: var(--text-muted, #4a7);
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pt-toggle {
    cursor: pointer;
    user-select: none;
  }

  .pt-toggle input {
    cursor: pointer;
  }

  .pt-select {
    height: 1.9rem;
    border: 1px solid var(--border, #ccc);
    border-radius: var(--radius-sm, 6px);
    background: var(--bg, #fff);
    color: inherit;
    font: inherit;
    font-size: 0.85rem;
    padding: 0 0.4rem;
    cursor: pointer;
  }

  .print-surface {
    flex: 1 1 auto;
    overflow: auto;
    min-height: 0;
    padding: 1.5rem;
    display: flex;
    justify-content: center;
  }

  /* An on-screen sheet of "paper": a centred white column so the preview mirrors
     the printed page. `padding` (the margin) + `font-size` are set inline. */
  .print-page {
    width: 100%;
    max-width: 210mm; /* A4 width */
    align-self: flex-start;
    background: #fff;
    color: #111;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.18);
    box-sizing: border-box;
  }

  /* Page-break guides: a dashed line every content-page height, aligned to the
     content box so line N marks the end of printed page N. Screen-only. */
  .print-page.page-guides {
    background-image: repeating-linear-gradient(
      to bottom,
      transparent 0,
      transparent calc(var(--page-height) - 1px),
      rgba(200, 60, 60, 0.55) calc(var(--page-height) - 1px),
      rgba(200, 60, 60, 0.55) var(--page-height)
    );
    background-origin: content-box;
    background-clip: content-box;
    background-repeat: repeat-y;
  }

  .print-error {
    color: var(--danger, #c0392b);
  }

  /* --- Print → paper -------------------------------------------------------
     Only the Concept body prints: drop the toolbar + the on-screen sheet
     scaffolding, force the LIGHT palette on white (dark paper wastes ink and
     reads wrong), and keep block backgrounds via print-color-adjust. The real
     page margin is applied through the live `@page` rule injected in script. */
  @media print {
    .print-view {
      display: block;
      height: auto;
      background: #fff;
      /* Force the light token palette whatever the OS/user theme. */
      --bg: #fff;
      --bg-elevated: #fff;
      --bg-sunken: #f2f2f2;
      --text: #111;
      --text-muted: #444;
      --border: #ccc;
      --accent: #1a3a6b;
      color: #111;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }

    .print-toolbar {
      display: none !important;
    }

    .print-surface {
      display: block;
      overflow: visible;
      padding: 0;
    }

    .print-page {
      max-width: none;
      box-shadow: none;
      /* Margin is owned by `@page` at print time; drop the on-screen padding. */
      padding: 0 !important;
      /* Guides are a screen aid; print-color-adjust would otherwise keep them. */
      background-image: none !important;
    }

    /* Don't strand a heading at a page bottom; don't split code blocks, tables
       or diagrams across a page boundary. Body HTML is injected (unscoped), so
       these are `:global`. */
    .print-page :global(h1),
    .print-page :global(h2),
    .print-page :global(h3),
    .print-page :global(h4) {
      break-after: avoid;
    }

    .print-page :global(pre),
    .print-page :global(table),
    .print-page :global(.web-mermaid) {
      break-inside: avoid;
    }

    /* CriticMarkup: force the light-paper palette (dark tints wash out on white);
       explicit colours so print-color-adjust: exact keeps them. */
    .print-page :global(.critic-highlight) {
      background-color: rgba(255, 208, 0, 0.35);
    }
    .print-page :global(ins.critic-add) {
      color: #1a7f37;
      background-color: rgba(26, 127, 55, 0.14);
    }
    .print-page :global(del.critic-del) {
      color: #b3261e;
      background-color: rgba(179, 38, 30, 0.12);
    }
  }
</style>
