/**
 * The one `<img>` builder both Embed surfaces use (af-1).
 *
 * An Embed (`![alt](x.png)` / `![[x.png]]`) becomes an image in two places that
 * otherwise share no code: the editor's `embedBlocks` CodeMirror widget
 * (`src/lib/editor/embeds.ts`) and the server-rendered HTML the web viewer and
 * the print page show (`src/lib/web/remoteEmbed.ts`, swapping a click-to-load
 * button for the real image). The DOM they must produce is identical, and the
 * rules it has to keep are easy to half-remember:
 *
 *   * the class is `embed-image` — the name `src/lib/rendered.css` styles and
 *     the contract between the two surfaces;
 *   * a requested `|300` size is INLINE CSS, never the HTML `width`/`height`
 *     attributes. Those belong to the editor's URL-keyed dimension cache, which
 *     stores NATURAL dimensions; mixing the two lets two differently-sized
 *     Embeds of one file corrupt each other's entry (ADR-0010);
 *   * `loading="lazy"`;
 *   * `src` is assigned LAST, after any `load`/`error` listener is attached — a
 *     cached image can fire `load` synchronously on assignment, and a listener
 *     added afterwards would miss it.
 *
 * Deliberately free of CodeMirror, Svelte and the backend seam, so either side
 * can import it.
 */
export interface EmbedImageOptions {
  /** The URL to load. Assigned last. */
  src: string;
  /** The accessible name. Never `''` for an Embed (ADR-0010). */
  alt: string;
  /** An explicit size as a CSS declaration list (`width:300px;height:200px`). */
  style?: string | null;
  /** Known NATURAL dimensions, pinned as HTML attributes to reserve the box. */
  natural?: { w: number; h: number } | null;
  /** Called once the bytes decode. */
  onLoad?: (img: HTMLImageElement) => void;
  /** Called when the bytes fail to load (a 404, a non-image, a dead host). */
  onError?: (img: HTMLImageElement) => void;
}

/** Build the `<img>` for an Embed. */
export function createEmbedImage(opts: EmbedImageOptions): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'embed-image';
  img.alt = opts.alt;
  img.loading = 'lazy';

  // Natural dimensions -> ATTRIBUTES: the box is reserved at the right aspect
  // ratio before decode, so a remounting image cannot grow the heightmap under
  // an in-flight scroll.
  if (opts.natural) {
    img.width = opts.natural.w;
    img.height = opts.natural.h;
  }
  // A requested size -> CSS, which overrides the attributes above.
  if (opts.style) img.setAttribute('style', opts.style);

  if (opts.onLoad) img.addEventListener('load', () => opts.onLoad?.(img));
  if (opts.onError) img.addEventListener('error', () => opts.onError?.(img));

  img.src = opts.src;
  return img;
}

/**
 * The CSS declaration list for an explicit Embed size, or `null` when there is
 * none — the string form of `embedSizeCss`, and the value the shared Rust
 * renderer puts in `style` / `data-embed-style`.
 */
export function embedStyleAttr(width: string | null, height: string | null): string | null {
  const parts: string[] = [];
  if (width) parts.push(`width:${width}`);
  if (height) parts.push(`height:${height}`);
  return parts.length > 0 ? parts.join(';') : null;
}
