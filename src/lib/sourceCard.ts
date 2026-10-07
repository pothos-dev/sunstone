import type { Source } from '$lib/wasm/exports';

// ---------------------------------------------------------------------------
// Source hover card (ov-17)
//
// The details of a `sources` entry, shown the moment the pointer enters a
// footnote that cites it or a title in the Sources section; the native `title`
// tooltip waits about a second and cannot be styled. The editor attaches it to
// its widgets (`attachSourceCard`); the web viewer binds it once over the
// server-rendered body (`bindSourceCards`), whose source footnotes and titles
// carry their entry as `data-source` JSON (`render/footnotes.rs`). One card at a time,
// fixed-positioned in `document.body` so the editor's scroller cannot clip it,
// styled by `.source-card` in `app.css`. It hides on leave, on click and on
// any scroll.
// ---------------------------------------------------------------------------

const GAP = 6;
const MARGIN = 8;

interface Rect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

/**
 * Where to put a `w`×`h` card for an anchor at `a` in a `vw`×`vh` viewport:
 * below the anchor, centred on it, flipped above when it does not fit below,
 * and kept `MARGIN` inside the viewport.
 */
export function placeCard(a: Rect, w: number, h: number, vw: number, vh: number) {
  const left = Math.min(Math.max(a.left + a.width / 2 - w / 2, MARGIN), vw - w - MARGIN);
  const below = a.bottom + GAP;
  const top = below + h > vh - MARGIN && a.top - GAP - h >= MARGIN ? a.top - GAP - h : below;
  return { left: Math.max(left, MARGIN), top };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** The card's DOM for `s`. */
function buildCard(s: Source): HTMLElement {
  const card = el('div', 'source-card');
  card.dataset.testid = 'source-card';
  card.setAttribute('role', 'tooltip');
  if (s.num != null) {
    const head = el('div', 'source-card-head');
    head.append(el('span', 'source-card-num', `${s.num}`));
    card.append(head);
  }
  card.append(el('div', 'source-card-title', s.title ?? s.resource ?? s.id ?? ''));
  if (s.title != null && s.resource) card.append(el('div', 'source-card-resource', s.resource));
  const meta: [string, string | null | undefined][] = [
    ['Author', s.author],
    ['Last modified', s.lastModified],
    ['Usage count', s.usageCount],
  ];
  const rows = meta.filter(([, v]) => v != null && v !== '');
  if (rows.length > 0) {
    const dl = el('dl', 'source-card-meta');
    for (const [k, v] of rows) dl.append(el('dt', '', k), el('dd', '', v!));
    card.append(dl);
  }
  if (s.kind !== 'descriptor') card.append(el('div', 'source-card-hint', 'Click to open'));
  return card;
}

let current: { card: HTMLElement; anchor: HTMLElement } | null = null;

function hide(): void {
  current?.card.remove();
  current = null;
  window.removeEventListener('scroll', hide, true);
}

function show(anchor: HTMLElement, s: Source): void {
  hide();
  const card = buildCard(s);
  card.style.visibility = 'hidden';
  document.body.append(card);
  const r = anchor.getBoundingClientRect();
  const { left, top } = placeCard(
    r,
    card.offsetWidth,
    card.offsetHeight,
    window.innerWidth,
    window.innerHeight,
  );
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  card.style.visibility = '';
  current = { card, anchor };
  window.addEventListener('scroll', hide, true);
}

/** Show `s`'s card while the pointer is over `anchor`. */
export function attachSourceCard(anchor: HTMLElement, s: Source): void {
  anchor.addEventListener('mouseenter', () => show(anchor, s));
  anchor.addEventListener('mouseleave', () => {
    if (current?.anchor === anchor) hide();
  });
  anchor.addEventListener('mousedown', () => {
    if (current?.anchor === anchor) hide();
  });
}

/**
 * Show cards over every `[data-source]` element inside `root` (server-rendered
 * HTML). Delegated, so it survives the body being replaced. Returns the unbind.
 */
export function bindSourceCards(root: HTMLElement): () => void {
  const anchorOf = (t: EventTarget | null) =>
    t instanceof Element ? (t.closest('[data-source]') as HTMLElement | null) : null;
  const over = (e: MouseEvent) => {
    const a = anchorOf(e.target);
    if (!a || !root.contains(a) || current?.anchor === a) return;
    try {
      show(a, JSON.parse(a.dataset.source ?? '') as Source);
    } catch {
      // Malformed data: no card.
    }
  };
  const out = (e: MouseEvent) => {
    const a = anchorOf(e.target);
    if (a && current?.anchor === a && !a.contains(e.relatedTarget as Node | null)) hide();
  };
  const down = () => hide();
  root.addEventListener('mouseover', over);
  root.addEventListener('mouseout', out);
  root.addEventListener('mousedown', down);
  return () => {
    root.removeEventListener('mouseover', over);
    root.removeEventListener('mouseout', out);
    root.removeEventListener('mousedown', down);
    hide();
  };
}

/** Remove the card if its anchor is inside `dom` (a widget being destroyed). */
export function detachSourceCard(dom: HTMLElement): void {
  if (current && dom.contains(current.anchor)) hide();
}
