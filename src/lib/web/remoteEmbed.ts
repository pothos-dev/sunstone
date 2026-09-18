/**
 * Click-to-load for REMOTE Embeds in server-rendered Concept HTML (af-1,
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

import { createEmbedImage } from '$lib/embedImage';

/**
 * The `<img>` a remote placeholder becomes once the reader asks for it.
 *
 * The element itself is built by the shared `createEmbedImage` (`embed-image`,
 * `loading="lazy"`, a requested size as CSS and never as HTML attributes,
 * `src` assigned last) — the SAME builder the editor's Embed widget uses, so the
 * two surfaces cannot drift on any of those rules.
 */
function imageFor(button: HTMLElement): HTMLImageElement | null {
  const src = button.dataset.embedSrc;
  if (!src) return null;
  return createEmbedImage({
    src,
    alt: button.dataset.embedAlt ?? '',
    style: button.dataset.embedStyle ?? null,
  });
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
