import { actorView } from '$lib/actor';
import { trustOf, type Stamp, type Trust, type TrustTier } from '$lib/wasm/exports';

// ---------------------------------------------------------------------------
// The trust line (OKF v0.2 §5.2, §5.3, ov-9)
//
// One line above the body that says who wrote a Concept, who confirmed it and
// how recently, with the derived trust tier first. The reading of the keys —
// the bare `verified` mapping as a one-element list, the tier, the legacy
// `timestamp` fallback — is `sunstone_shared::trust` over wasm (`trustOf`);
// this module only builds the markup. The native render emits the same markup
// (`sunstone-native/src/render/trust.rs`), styled by `.trust*` in `app.css`:
//
//   <div class="trust trust-human-reviewed" data-testid="trust">
//     <span class="trust-tier" title="…">Human-reviewed</span>
//     <span class="trust-generated"><span class="trust-label">Generated</span> by
//       <span class="actor …">…</span> <time class="trust-at" …>2026-06-20</time></span>
//     <span class="trust-verified"><span class="trust-label">Verified</span>
//       <span class="trust-event">…actor… <time …>…</time></span>…</span>
//   </div>
//
// A Concept with none of the keys gets no line at all. A legacy `timestamp`
// alone shows as the generation time with no tier. A `generated` with no `by`
// says so (`.trust-missing`) instead of disappearing. A datetime is shown as
// its date when it is ISO 8601 with an offset, otherwise verbatim; its full
// text is the tooltip either way.
// ---------------------------------------------------------------------------

export type { Trust, TrustTier, Stamp };

/** The tier names readers see, lowest to highest (§5.3). */
export const TIER_LABEL: Record<TrustTier, string> = {
  unverified: 'Unverified',
  machineConfirmed: 'Machine-confirmed',
  humanReviewed: 'Human-reviewed',
};

/** What each tier means, for the chip's tooltip. */
const TIER_HINT: Record<TrustTier, string> = {
  unverified: 'Trust tier (OKF §5.3): nobody has confirmed this Concept',
  machineConfirmed: 'Trust tier (OKF §5.3): confirmed by processes or agents only',
  humanReviewed: 'Trust tier (OKF §5.3): confirmed by a person',
};

/** The CSS class suffix of each tier (`trust-human-reviewed`). */
const TIER_CLASS: Record<TrustTier, string> = {
  unverified: 'unverified',
  machineConfirmed: 'machine-confirmed',
  humanReviewed: 'human-reviewed',
};

/** The trust line for a Frontmatter block (inner YAML), or `''` when it has none. */
export function trustLineHtml(yaml: string): string {
  const t = trustOf(yaml);
  return t ? trustHtml(t) : '';
}

/** The trust line's markup for parsed trust Frontmatter. */
export function trustHtml(t: Trust): string {
  const parts: string[] = [];
  if (t.trustKeys) {
    parts.push(
      `<span class="trust-tier" title="${esc(TIER_HINT[t.tier])}">${TIER_LABEL[t.tier]}</span>`,
    );
  }
  const g = t.generated;
  if (g) {
    let by = '';
    if (!t.legacy) {
      by = g.by
        ? ` by ${actorHtml(g.by)}`
        : ` <span class="trust-missing" title="${esc('`generated` has no `by` (OKF §5.2)')}">by unknown</span>`;
    }
    const at = g.at ? ` ${timeHtml(g.at, g.iso)}` : '';
    const title = t.legacy ? ` title="${esc('From the legacy `timestamp` (OKF §13.1)')}"` : '';
    parts.push(
      `<span class="trust-generated"${title}><span class="trust-label">Generated</span>${by}${at}</span>`,
    );
  }
  if (t.verified.length > 0) {
    const events = t.verified.map((e) => {
      const by = e.by ? actorHtml(e.by) : '<span class="trust-missing">unknown</span>';
      const at = e.at ? ` ${timeHtml(e.at, e.iso)}` : '';
      return `<span class="trust-event">${by}${at}</span>`;
    });
    parts.push(
      `<span class="trust-verified"><span class="trust-label">Verified</span> ${events.join(' ')}</span>`,
    );
  }
  const tier = t.trustKeys ? ` trust-${TIER_CLASS[t.tier]}` : '';
  return `<div class="trust${tier}" data-testid="trust">${parts.join(' ')}</div>`;
}

/** An actor's markup: the same `.actor*` shape `actorElement` builds. */
export function actorHtml(raw: string): string {
  const v = actorView(raw);
  const chip = v.kindLabel ? `<span class="actor-kind">${esc(v.kindLabel)}</span>` : '';
  const version = v.version ? `<span class="actor-version">${esc(v.version)}</span>` : '';
  return (
    `<span class="actor actor-${v.kind}" title="${esc(v.title)}">` +
    `${chip}<span class="actor-id">${esc(v.text)}</span>${version}</span>`
  );
}

/** A datetime: its date when ISO with an offset, else verbatim; full text on hover. */
function timeHtml(at: string, iso: boolean): string {
  const shown = iso ? at.slice(0, 10) : at;
  const datetime = iso ? ` datetime="${esc(at)}"` : '';
  return `<time class="trust-at"${datetime} title="${esc(at)}">${esc(shown)}</time>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
