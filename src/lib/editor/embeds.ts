import { StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { backend } from '$lib/ipc';
import { createEmbedImage, embedStyleAttr } from '$lib/embedImage';
import { indexStore } from '$lib/state/index.svelte';
import {
  classifyEmbedTarget,
  isImageAttachment,
  resolveEmbedNameIn,
  resolveEmbedPathIn,
  scanEmbedsUtf16,
} from '$lib/wasm/exports';
import { refreshBrokenLinks } from './broken-links';
import { openEmbedLightbox } from './embedLightbox';
import {
  embedSizeCss,
  embedWidgetKey,
  planEmbeds,
  type EmbedPlan,
} from './embedPlan';

// ---------------------------------------------------------------------------
// Embed rendering (slice: embedded-images, ADR-0010)
//
// `embedBlocks()` is Sunstone's replacement for atomic-editor's `imageBlocks()`,
// which is REMOVED from the extension list (`extensions.ts`) so nothing
// double-renders. It is one `StateField` emitting exactly one POINT
// `Decoration.widget` per Embed and NEVER a replace:
//
//   * hiding the raw `![alt](x.png)` source, and revealing it again under the
//     cursor, is entirely `inlinePreview`'s job — it already replaces the whole
//     `Image` node on inactive lines (`inline-preview.js:553-572`) and treats no
//     line as active when Sunstone's patched `alwaysRender` flag is set in
//     `read` mode. We layer over it; we never fight it and never patch it;
//   * a BLOCK widget must come from a StateField (CM6 forbids ViewPlugin-sourced
//     block decorations), and one field serves the inline case too.
//
// The placement/render decisions are all in the pure, unit-tested `embedPlan.ts`
// (the `mermaidBlocks.ts` / `mermaid.ts` split). This module is the CM/DOM shell
// only: the field, the widget, the `dimensionCache`, the click gestures and the
// `cm-embed-*` styling. The `<img>` itself and the two placeholders use the
// SHARED class names (`embed-image` / `embed-broken` / `embed-remote`) and the
// shared `createEmbedImage` builder, so the editor and the server render
// (`src/lib/rendered.css`, `src/lib/web/remoteEmbed.ts`) cannot drift.
//
// OFFSETS: the field scans with `scanEmbedsUtf16`, not `scanEmbeds`. The kernel
// reports BYTE offsets by default — the unit the SSR renderer and the rewrite
// engine slice Rust strings with — and CodeMirror positions are UTF-16 code
// units, so a byte offset puts every decoration after the first non-ASCII
// character in the document in the wrong place. The UTF-16 variant lives in
// `crates/sunstone-shared/src/embed.rs` beside the byte one, exactly as
// `critic.rs` and `citations.rs` already report this seam (ADR 0006 §4).
// ---------------------------------------------------------------------------

/**
 * Session-lifetime cache of observed NATURAL image dimensions, keyed by URL —
 * upstream `imageBlocks`' trick, kept verbatim and for its original reason.
 *
 * CM6's virtualizer unmounts line DOM when it leaves the viewport and calls
 * `toDOM` again on the way back. Without the cache an `<img>` remounts with no
 * intrinsic size, lays out as a zero-height box and snaps to its real size once
 * decode completes — the heightmap grows under an in-flight scroll, which on iOS
 * reads as an anchor conflict and halts kinetic scrolling. Setting the `width` /
 * `height` ATTRIBUTES from this cache pins the aspect ratio on mount.
 *
 * It stores natural dimensions ONLY. An explicit `|300` size is applied as CSS
 * (see `embedSizeCss`), so two differently-sized Embeds of one file cannot
 * corrupt each other's entry (ADR-0010).
 */
const dimensionCache = new Map<string, { w: number; h: number }>();

/** Record an image's natural size the first time we see it decoded. */
function rememberDimensions(img: HTMLImageElement, src: string): void {
  if (img.naturalWidth > 0 && img.naturalHeight > 0 && !dimensionCache.has(src)) {
    dimensionCache.set(src, { w: img.naturalWidth, h: img.naturalHeight });
  }
}

/**
 * The error placeholder, for BOTH failure states ADR-0010 collapses into one
 * visual: an unresolvable target, and a resolved target whose bytes fail to
 * load (the second is the one upstream has no handler for at all). Styled like
 * `cm-broken-link` — `var(--danger)`, dashed.
 *
 * The markup mirrors what the shared Rust renderer emits for the web view and
 * the print export — `<span class="embed-broken" data-broken="true"
 * data-embed-target=…>Missing attachment: …</span>`, styled in
 * `src/lib/rendered.css` — so the two surfaces read identically. The extra
 * `cm-embed-broken` is only this file's `EditorView.theme` hook, since
 * `rendered.css` scopes its rules under `.rendered`.
 */
function errorPlaceholder(alt: string, target: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'cm-embed-broken embed-broken';
  el.dataset.broken = 'true';
  el.dataset.embedTarget = target;
  el.textContent = `Missing attachment: ${alt}`;
  el.title = `No Attachment resolves ${target}`;
  return el;
}

/**
 * The neutral click-to-load affordance for a remote (`http`/`https`) Embed.
 * Opening a Concept must not fire a tracking pixel from a reader's browser, so
 * NOTHING is fetched here: the `<img>` is created, and its `src` set, only when
 * this button is clicked. Deliberately NOT an error visual — a remote Embed is a
 * normal state.
 */
function remoteAffordance(plan: EmbedPlan, load: () => void): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-embed-remote embed-remote';
  // The same `data-embed-*` vocabulary the shared renderer puts on ITS button,
  // so one stylesheet and one mental model serve both surfaces — and, like it,
  // NO `src` anywhere until the reader asks.
  button.dataset.embedSrc = plan.src;
  button.dataset.embedAlt = plan.alt;
  const requested = embedSizeCss(plan.width, plan.height);
  const style = embedStyleAttr(requested.width, requested.height);
  if (style) button.dataset.embedStyle = style;
  button.textContent = `Load remote image — ${hostOf(plan.src)}`;
  button.title = plan.src;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    // Keep the click off the wrapper's caret/lightbox handler.
    event.stopPropagation();
    load();
  });
  button.addEventListener('mousedown', (event) => event.stopPropagation());
  return button;
}

/** The host of a remote URL, for the affordance label. Falls back to the URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The point widget for one Embed. `eq()` is keyed on the pure
 * `embedWidgetKey` — `(render, placement, width, height, alt, src)` — so an
 * unrelated edit produces an EQUAL widget, CodeMirror reuses the element, and
 * the browser never re-decodes the image (ADR-0010; the caching lesson ADR-0005
 * records, in the form this field needs it).
 */
class EmbedWidget extends WidgetType {
  readonly key: string;

  constructor(
    readonly plan: EmbedPlan,
    readonly reading: boolean,
  ) {
    super();
    this.key = embedWidgetKey(plan);
  }

  eq(other: EmbedWidget): boolean {
    return other.key === this.key && other.reading === this.reading;
  }

  /**
   * The `<img>` for a resolved (or just-loaded remote) Embed, built by the
   * SHARED `createEmbedImage` — the same builder `src/lib/web/remoteEmbed.ts`
   * uses for the server-rendered surface, so the `embed-image` class, the lazy
   * loading, the "a requested size is CSS, never HTML attributes" rule and the
   * "assign `src` last" ordering cannot drift between the two.
   *
   * An explicit `|300` / `300x200` becomes CSS. A width alone leaves
   * `height: auto` from the theme, so the ratio holds; a width larger than the
   * natural width UPSCALES (Obsidian's behaviour) while `max-width: 100%` still
   * lets the content column clamp it.
   */
  private image(src: string, host: HTMLElement): HTMLImageElement {
    const requested = embedSizeCss(this.plan.width, this.plan.height);
    return createEmbedImage({
      src,
      alt: this.plan.alt,
      style: embedStyleAttr(requested.width, requested.height),
      natural: dimensionCache.get(src) ?? null,
      onLoad: (img) => rememberDimensions(img, src),
      // Upstream has no error handling at all: a resolved path whose bytes fail
      // to load would render as the browser's broken-image glyph. ADR-0010
      // folds that into the SAME placeholder an unresolvable target gets.
      onError: () => {
        host.replaceChildren(errorPlaceholder(this.plan.alt, this.plan.target));
        host.classList.add('cm-embed-failed');
      },
    });
  }

  toDOM(view: EditorView): HTMLElement {
    const block = this.plan.placement === 'block';
    const wrap = document.createElement(block ? 'div' : 'span');
    wrap.className = `cm-embed ${block ? 'cm-embed-block' : 'cm-embed-inline'}`;
    if (this.reading && this.plan.render === 'image') wrap.classList.add('cm-embed-zoomable');

    if (this.plan.render === 'error') {
      wrap.appendChild(errorPlaceholder(this.plan.alt, this.plan.target));
    } else if (this.plan.render === 'remote') {
      const src = this.plan.src;
      wrap.appendChild(
        remoteAffordance(this.plan, () => {
          wrap.replaceChildren(this.image(src, wrap));
        }),
      );
    } else {
      wrap.appendChild(this.image(this.plan.src, wrap));
    }

    // --- Click gesture -----------------------------------------------------
    // `editing`: upstream's caret-to-source. The source line is hidden by
    // `inlinePreview`, so this is the only way to reach it. The position is
    // resolved from the widget's CURRENT DOM location at event time
    // (`posAtDOM`), never from a captured offset, so it stays correct after an
    // unrelated edit shifted the range.
    //
    // `read`: there is no caret to place, so the gesture buys a lightbox — but
    // only for an image the content column actually DOWNSCALED. A picture shown
    // at or above its natural size has nothing more to reveal.
    if (this.reading) {
      wrap.addEventListener('click', (event) => {
        const img = wrap.querySelector('img');
        if (!(img instanceof HTMLImageElement) || img.naturalWidth === 0) return;
        if (img.clientWidth >= img.naturalWidth) return;
        event.preventDefault();
        event.stopPropagation();
        openEmbedLightbox(img.currentSrc || img.src, this.plan.alt);
      });
    } else {
      wrap.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const pos = view.posAtDOM(wrap);
        if (pos < 0) return;
        // A block widget sits at `line.to` with `side: 1`, so CM6 would map a
        // click to the START of the NEXT line; step back into the source line.
        // An inline widget already sits at the Embed's end, on the source line.
        const target = block ? Math.max(0, pos - 1) : pos;
        view.focus();
        view.dispatch({ selection: { anchor: target }, scrollIntoView: false });
      });
    }

    return wrap;
  }

  /** Our listeners above are the sole decider of what a pointer event means. */
  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'click';
  }
}

/**
 * Build the widget set for the current state: scan the body for Embeds (UTF-16
 * offsets), plan each one, and emit a block or inline point widget at the
 * planned anchor. `Decoration.set(_, true)` sorts, since block widgets anchor at
 * `line.to` while inline ones anchor at the Embed's end.
 */
function buildEmbeds(
  state: EditorState,
  reading: boolean,
  currentPath: () => string,
): DecorationSet {
  const embeds = scanEmbedsUtf16(state.doc.toString());
  if (embeds.length === 0) return Decoration.none;

  const source = currentPath();
  // The Attachment corpus is a SEPARATE index from the Concept path set (an
  // Attachment is never a Concept), read fresh per build so a newly added image
  // resolves on the next rebuild.
  const attachments = indexStore.attachmentPaths();

  const plans = planEmbeds(embeds, state.doc, {
    reading,
    selection: state.selection.ranges,
    classify: classifyEmbedTarget,
    isImage: isImageAttachment,
    // The name model searches the Attachment corpus, so a miss is known here
    // and becomes the error placeholder immediately. The path model is pure
    // path math and deliberately does NOT consult `indexStore.attachmentExists`:
    // the Attachment index is empty until the first refresh, and gating on it
    // would flash every local Embed as broken on the first frame. A path with
    // nothing behind it still yields a URL, the `<img>` fails, and `onError`
    // shows the SAME placeholder — which is exactly what ADR-0010 asks for.
    resolve: (embed) =>
      embed.kind === 'name'
        ? resolveEmbedNameIn(attachments, embed.target)
        : resolveEmbedPathIn(source, embed.target),
    // Synchronous on purpose — a decoration builder cannot await (see the
    // contract on `Backend.attachmentUrl`).
    url: (path) => backend.attachmentUrl(path),
  });

  return Decoration.set(
    plans.map((plan) =>
      Decoration.widget({
        widget: new EmbedWidget(plan, reading),
        block: plan.placement === 'block',
        // `side: 1` puts a block widget AFTER its line's content (the image sits
        // below its source) and an inline widget after the Embed's last
        // character (so it follows the text it belongs to).
        side: 1,
      }).range(plan.at),
    ),
    true,
  );
}

/**
 * The Embed StateField. Rebuilds on:
 *   - a doc change (an Embed may have been added, removed, resized or retargeted);
 *   - a selection change (the inline cursor-overlap reveal);
 *   - `refreshBrokenLinks`, which the host already dispatches on the
 *     `file-changed` watcher event and on a Concept switch — exactly the events
 *     that can change whether an Attachment resolves.
 */
function embedField(reading: boolean, currentPath: () => string): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: (state) => buildEmbeds(state, reading, currentPath),
    update(deco, tr) {
      for (const effect of tr.effects) {
        if (effect.is(refreshBrokenLinks)) {
          return buildEmbeds(tr.state, reading, currentPath);
        }
      }
      if (tr.docChanged || tr.selection) {
        return buildEmbeds(tr.state, reading, currentPath);
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/**
 * Embed styling.
 *
 * The visuals are deliberately the SAME two `src/lib/rendered.css` gives the
 * server-rendered surface — the broken placeholder mirrors `cm-broken-link`
 * (`var(--danger)`, dashed), the remote affordance is neutral because a remote
 * Embed is a normal state and not an error — but the rules have to be restated
 * here: `rendered.css` scopes everything under `.rendered`, which the editor's
 * DOM is not. Keep the two in step; the class names are the contract.
 */
export const embedTheme = EditorView.theme({
  '.cm-embed-block': {
    display: 'block',
    padding: '0.25rem 0',
  },
  '.cm-embed-inline': {
    display: 'inline-block',
    verticalAlign: 'text-bottom',
  },
  // `max-width: 100%` keeps an explicit size a REQUEST the content column may
  // clamp; `height: auto` preserves the ratio when only a width was asked for.
  // An inline explicit `style.width` overrides both.
  '.cm-embed .embed-image': {
    maxWidth: '100%',
    height: 'auto',
    borderRadius: 'var(--radius-sm, 4px)',
  },
  // Reading mode: a click may open the lightbox, so hint at it.
  '.cm-embed-zoomable .embed-image': {
    cursor: 'zoom-in',
  },
  '.cm-embed-broken': {
    display: 'inline-block',
    padding: '0.05em 0.4em',
    border: '1px dashed var(--danger, #c0392b)',
    borderRadius: 'var(--radius-sm, 4px)',
    background: 'var(--danger-soft, rgba(192, 57, 43, 0.08))',
    color: 'var(--danger, #c0392b)',
    fontSize: '0.85em',
    cursor: 'help',
  },
  '.cm-embed-remote': {
    display: 'inline-flex',
    alignItems: 'center',
    maxWidth: '100%',
    padding: '0.2em 0.6em',
    border: '1px dashed var(--border, #bbb)',
    borderRadius: 'var(--radius-sm, 4px)',
    background: 'var(--bg-sunken, rgba(127, 127, 127, 0.08))',
    color: 'var(--text-muted, #777)',
    font: 'inherit',
    fontSize: '0.85em',
    lineHeight: '1.6',
    cursor: 'pointer',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  '.cm-embed-remote:hover': {
    background: 'var(--hover, rgba(127, 127, 127, 0.15))',
    color: 'var(--text, inherit)',
  },
});

/**
 * The Embed extension (ADR-0010). Wire into `modeExtensions` for BOTH modes,
 * BEFORE `inlinePreview` — it is that extension which hides the raw source this
 * field renders over, and which we must not overlap.
 *
 * @param reading     `read` mode: the inline cursor-overlap reveal is off (there
 *                    is no caret) and a click opens the lightbox instead of
 *                    placing the caret.
 * @param currentPath the open Concept's bundle-relative path, read per build —
 *                    the base a path-model Embed (`![alt](./x.png)`) resolves
 *                    against.
 */
export function embedBlocks(reading: boolean, currentPath: () => string): Extension {
  return [embedField(reading, currentPath), embedTheme];
}
