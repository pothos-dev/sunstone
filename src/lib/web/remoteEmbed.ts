/**
 * Click-to-load for REMOTE Embeds in server-rendered Concept HTML (ei-1,
 * ADR-0011).
 *
 * The shared Rust renderer never gives an `http(s)` Embed a real `src`: it emits
 *
 *   <button class="embed-remote" data-embed-src=… data-embed-alt=… data-embed-style=…>
 *
 * so that opening a Concept fetches nothing. On the web shell the author and the
 * reader are different people, and an automatic load would fire the author's
 * tracking pixel from the reader's browser and IP. A remote image is a normal
 * state, not an error — the reader just has to ask for it, once, per element.
 *
 * Both surfaces that show that HTML wire this: the read-only web viewer
 * (`WebViewer.svelte`) and the print/PDF preview (`PrintView.svelte`).
 */

/** The `<img>` a remote placeholder becomes once the reader asks for it. */
function imageFor(button: HTMLElement): HTMLImageElement | null {
  const src = button.dataset.embedSrc;
  if (!src) return null;
  const img = document.createElement('img');
  img.className = 'embed-image';
  img.src = src;
  img.alt = button.dataset.embedAlt ?? '';
  img.loading = 'lazy';
  // The size the author requested, as CSS (never HTML attributes) — the same
  // rule the renderer follows for local Embeds.
  const style = button.dataset.embedStyle;
  if (style) img.setAttribute('style', style);
  return img;
}

/**
 * Delegate click-to-load on `root` (the element holding the rendered body).
 * Returns the teardown, so a Svelte `$effect` can just return it.
 */
export function wireRemoteEmbeds(root: HTMLElement): () => void {
  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const button = target?.closest<HTMLElement>('button.embed-remote');
    if (!button || !root.contains(button)) return;
    e.preventDefault();
    const img = imageFor(button);
    if (img) button.replaceWith(img);
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
