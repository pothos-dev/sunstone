// ---------------------------------------------------------------------------
// Embed lightbox (slice: embedded-images, ADR-0010)
//
// In `read` mode the click gesture on an Embed is free — the source is
// unreachable and caret placement is meaningless — so ADR-0010 spends it on a
// lightbox for images the content column has DOWNSCALED (rendered width <
// natural width). Clicking one opens it at full size over the app.
//
// It is a real focus-managed surface, not a styled div: `Escape` closes it,
// focus is trapped inside while it is open, and focus is restored to whatever
// had it when it opened. It mounts on `document.body` rather than inside the
// editor, so it escapes the `.cm-scroller` clipping context — which also means
// `EditorView.theme` cannot reach it, hence the inline styling below.
// ---------------------------------------------------------------------------

/** The one open lightbox, if any — opening a second closes the first. */
let current: { close: () => void } | null = null;

/** Elements inside the surface that can take focus, in tab order. */
function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute('disabled'));
}

/**
 * Open the lightbox on `src`. Returns a `close()` the caller may keep; the
 * surface also closes itself on `Escape`, on a backdrop click and on the close
 * button. No-op (and returns a no-op) outside the browser.
 */
export function openEmbedLightbox(src: string, alt: string): () => void {
  if (typeof document === 'undefined') return () => {};
  current?.close();

  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const overlay = document.createElement('div');
  overlay.className = 'cm-embed-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', alt);
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2000',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '3rem',
    boxSizing: 'border-box',
    background: 'rgba(0, 0, 0, 0.72)',
    cursor: 'zoom-out',
  });

  const img = document.createElement('img');
  img.className = 'cm-embed-lightbox-img';
  img.src = src;
  img.alt = alt;
  Object.assign(img.style, {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    cursor: 'default',
    boxShadow: '0 0.5rem 2rem rgba(0, 0, 0, 0.5)',
  });

  const close = document.createElement('button');
  close.className = 'cm-embed-lightbox-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close image');
  close.textContent = '×';
  Object.assign(close.style, {
    position: 'absolute',
    top: '0.75rem',
    right: '0.75rem',
    width: '2.25rem',
    height: '2.25rem',
    border: 'none',
    borderRadius: '50%',
    background: 'rgba(255, 255, 255, 0.14)',
    color: '#fff',
    font: 'inherit',
    fontSize: '1.4rem',
    lineHeight: '1',
    cursor: 'pointer',
  });

  overlay.append(close, img);

  let closed = false;
  const dismiss = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    if (current?.close === dismiss) current = null;
    // Restore focus to whatever had it before the surface opened.
    previous?.focus();
  };

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    // Trap: cycle within the surface. With a single focusable element this
    // collapses to "Tab always lands back on the close button", which is the
    // point — focus must not escape into the editor behind the overlay.
    const items = focusable(overlay);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
    const next = event.shiftKey
      ? items[(index <= 0 ? items.length : index) - 1]
      : items[(index + 1) % items.length];
    event.preventDefault();
    next.focus();
  }

  close.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  });
  // Backdrop click closes; a click on the image itself does not.
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) dismiss();
  });
  img.addEventListener('mousedown', (event) => event.stopPropagation());
  document.addEventListener('keydown', onKeyDown, true);

  document.body.appendChild(overlay);
  close.focus();
  current = { close: dismiss };
  return dismiss;
}

/** Close the open lightbox, if there is one. Exposed for teardown. */
export function closeEmbedLightbox(): void {
  current?.close();
}
