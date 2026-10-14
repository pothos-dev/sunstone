// The Concept metadata pill in the Tile header (ov-24). Pure; no DOM, IPC or
// runes.
//
// Trust (OKF §5.2/§5.3), lifecycle (§5.4/§5.5) and provenance (§5.1) metadata
// sit next to the Concept title as ONE segmented pill — `[shield Reviewed |
// book 3 | clock stale]` — each segment shown only when its data exists. The
// pill only says *that* there is metadata and its state; hovering it opens a
// popover with the detail (Trust / Lifecycle / Sources). This module turns the
// parsed metadata into what both show; `MetaPill.svelte` only draws it.
//
// The reading of the keys stays where it is: trust is `sunstone_shared::trust`
// (wasm `trustOf`, or the render payload), lifecycle is `$lib/lifecycle`.

import type { Trust, TrustTier } from '$lib/wasm/exports';
import { lifecycleView, STATUS_MEANING, isLifecycleStatus, type Lifecycle, type LifecycleStatus } from '$lib/lifecycle';
import { TIER_HINT, TIER_LABEL } from '$lib/trust';
import { frontmatterTime, type FrontmatterTime } from '$lib/frontmatterTime';

/** The metadata a Concept carries, as the header needs it. */
export interface ConceptMeta {
  trust: Trust | null;
  lifecycle: Lifecycle | null;
  /** How many `sources` entries the Concept lists. */
  sourceCount: number;
}

/** A timestamp as written plus its relative form (`null` = show `at` as written). */
export interface MetaTime {
  at: string;
  time: FrontmatterTime | null;
}

/** One `generated` / `verified` row: who, and when. */
export interface StampRow {
  /** The actor string (§7), or `null` when missing. */
  actor: string | null;
  /** When, or `null` when the stamp has no `at`. */
  at: string | null;
  time: FrontmatterTime | null;
}

export interface MetaPillView {
  /** The trust-tier segment; `null` without `generated` / `verified`. */
  trust: { label: string; tier: TrustTier; accent: boolean; hint: string } | null;
  /** The sources segment (the count); `null` without `sources`. */
  sources: number | null;
  /** The lifecycle segment: `stale`, else a status other than `stable`. */
  lifecycle: { label: string; danger: boolean } | null;
  popover: {
    trust: {
      /** The tier chip; `null` for a legacy `timestamp` alone. */
      tier: { label: string; tier: TrustTier; hint: string } | null;
      generated: StampRow | null;
      /** `generated` is a legacy v0.1 `timestamp`. */
      legacy: boolean;
      verified: StampRow[];
    } | null;
    lifecycle: {
      /** A recognised `status`, else `null`. */
      status: LifecycleStatus | null;
      meaning: string | null;
      stale: boolean;
      staleAfter: MetaTime | null;
    } | null;
    sources: number;
  };
}

/** The short tier word the pill shows. */
const TIER_SHORT: Record<TrustTier, string> = {
  unverified: 'Unverified',
  machineConfirmed: 'Confirmed',
  humanReviewed: 'Reviewed',
};

function stampRow(s: { by: string | null; at: string | null }, now: number): StampRow {
  return { actor: s.by ?? null, at: s.at ?? null, time: frontmatterTime(s.at, now) };
}

/**
 * What the pill and its popover show for `meta` at `now`, or `null` when no
 * segment applies (no pill at all).
 */
export function metaPillView(meta: ConceptMeta, now: number): MetaPillView | null {
  const t = meta.trust;
  const trust = t?.trustKeys
    ? { label: TIER_SHORT[t.tier], tier: t.tier, accent: t.tier === 'humanReviewed', hint: TIER_HINT[t.tier] }
    : null;

  const lc = meta.lifecycle;
  const view = lifecycleView(lc, now);
  let lifecycle: MetaPillView['lifecycle'] = null;
  if (view?.stale) lifecycle = { label: 'stale', danger: true };
  else if (view?.status && view.status !== 'stable') lifecycle = { label: view.status, danger: false };

  const sources = meta.sourceCount > 0 ? meta.sourceCount : null;
  if (!trust && !lifecycle && sources === null) return null;

  const status = lc && isLifecycleStatus(lc.status) ? lc.status : null;
  return {
    trust,
    sources,
    lifecycle,
    popover: {
      trust: t
        ? {
            tier: t.trustKeys ? { label: TIER_LABEL[t.tier], tier: t.tier, hint: TIER_HINT[t.tier] } : null,
            generated: t.generated ? stampRow(t.generated, now) : null,
            legacy: t.legacy,
            verified: t.verified.map((s) => stampRow(s, now)),
          }
        : null,
      lifecycle: lc
        ? {
            status,
            meaning: status ? STATUS_MEANING[status] : null,
            stale: view?.stale ?? false,
            staleAfter: lc.staleAfter ? { at: lc.staleAfter, time: frontmatterTime(lc.staleAfter, now) } : null,
          }
        : null,
      sources: meta.sourceCount,
    },
  };
}
