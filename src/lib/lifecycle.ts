// The OKF v0.2 lifecycle of a Concept (§5.4 `status`, §5.5 `stale_after`), as
// the reader sees it. Pure; no DOM, IPC or runes.
//
// Staleness is DERIVED at display time — `now >= stale_after` — and never
// stored or written back. It is advisory: a stale or deprecated Concept stays
// fully readable and editable. A Concept with neither key gets no affordance.
//
// The language-service half (lint + completion) is `okf/families/lifecycle.ts`.

import { parseDocument, isScalar } from 'yaml';
import { parseInstant } from '$lib/instant';
import type { FrontmatterField, TreeNode } from '$lib/types';

/** The three `status` values §5.4 defines, in lifecycle order. */
export const LIFECYCLE_STATUSES = ['draft', 'stable', 'deprecated'] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/** What each status means (§5.4), for tooltips and completion info. */
export const STATUS_MEANING: Record<LifecycleStatus, string> = {
  draft: 'not yet reviewed; possibly incomplete',
  stable: 'ready for consumption (the default)',
  deprecated: 'kept for links and history; no longer current',
};

/** The two lifecycle keys as written: raw, non-empty strings or `null`. */
export interface Lifecycle {
  status: string | null;
  staleAfter: string | null;
}

/** What a summary surface shows: `null` means show nothing at all. */
export interface LifecycleView {
  /** A recognised `status`, else `null` (an unrecognised one is lint's business). */
  status: LifecycleStatus | null;
  /** Whether `now >= stale_after`. */
  stale: boolean;
  /** Tooltip text explaining the affordance. */
  title: string;
}

export function isLifecycleStatus(value: unknown): value is LifecycleStatus {
  return (LIFECYCLE_STATUSES as readonly unknown[]).includes(value);
}

/**
 * Whether a Concept with this `stale_after` is stale at `now` (§5.5:
 * `now >= stale_after`). Absent or malformed is never stale — the signal is
 * advisory, so an unreadable date must not mark anything.
 */
export function isStale(staleAfter: string | null | undefined, now: Date | number): boolean {
  if (staleAfter == null) return false;
  const at = parseInstant(staleAfter);
  return at !== null && +now >= at;
}

function text(value: unknown): string | null {
  if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

function lifecycle(status: string | null, staleAfter: string | null): Lifecycle | null {
  return status === null && staleAfter === null ? null : { status, staleAfter };
}

/** The lifecycle keys of a Frontmatter block (inner YAML), or `null` when neither is set or it does not parse. */
export function lifecycleFromYaml(yaml: string): Lifecycle | null {
  if (yaml.trim() === '') return null;
  let doc;
  try {
    doc = parseDocument(yaml, { uniqueKeys: false });
  } catch {
    return null;
  }
  if (doc.errors.length > 0) return null;
  const read = (key: string) => {
    const node = doc.get(key, true);
    return isScalar(node) ? text(node.value) : null;
  };
  return lifecycle(read('status'), read('stale_after'));
}

/** The lifecycle keys out of server-rendered Frontmatter fields (the web reader). */
export function lifecycleFromFields(fields: readonly FrontmatterField[]): Lifecycle | null {
  const read = (key: string) => {
    const f = fields.find((x) => x.key === key);
    return f && f.values.length === 1 ? text(f.values[0]) : null;
  };
  return lifecycle(read('status'), read('stale_after'));
}

/** The lifecycle keys an Explorer tree node carries (raw, from the walker). */
export function lifecycleOfNode(node: TreeNode): Lifecycle | null {
  return lifecycle(text(node.status), text(node.staleAfter));
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * What to show for `lc` at `now`, or `null` for nothing. A recognised status
 * always shows; `stale_after` shows only once it has passed (before then it is
 * just a line in the tooltip of a status chip). `compact` (dense lists such as
 * the Explorer) leaves out `stable`, the §5.4 default, so only the statuses
 * that ask the reader for caution mark a row.
 */
export function lifecycleView(
  lc: Lifecycle | null,
  now: Date | number,
  { compact = false }: { compact?: boolean } = {},
): LifecycleView | null {
  if (!lc) return null;
  let status = isLifecycleStatus(lc.status) ? lc.status : null;
  if (compact && status === 'stable') status = null;
  const stale = isStale(lc.staleAfter, now);
  if (status === null && !stale) return null;
  const parts: string[] = [];
  if (status) parts.push(`${capitalise(status)}: ${STATUS_MEANING[status]}.`);
  if (stale) parts.push(`Stale since ${lc.staleAfter}: treat as possibly out of date.`);
  else if (lc.staleAfter && parseInstant(lc.staleAfter) !== null) parts.push(`Stale after ${lc.staleAfter}.`);
  return { status, stale, title: parts.join(' ') };
}
