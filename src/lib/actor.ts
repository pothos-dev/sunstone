import { parseActor, type Actor, type ActorKind } from '$lib/wasm/exports';

// ---------------------------------------------------------------------------
// Actor display (OKF v0.2 §7)
//
// The ONE way an actor — `generated.by`, `verified[].by`, a source's `author` —
// is shown. Parsing is `sunstone_shared::actor` over wasm (ADR 0006); this
// module only decides the presentation, so every surface marks a person, a
// process and an agent the same way: a small kind chip, then the id (and an
// agent's version, muted). An unknown, malformed or empty actor shows its raw
// string and nothing else, never an error.
//
// Markup (`actorElement`), styled by `.actor*` in `app.css`:
//   <span class="actor actor-human" title="Person: ahormati">
//     <span class="actor-kind">person</span><span class="actor-id">ahormati</span>
//   </span>
// A Svelte consumer renders the same classes from `actorView`.
// ---------------------------------------------------------------------------

export type { Actor, ActorKind };

/** The chip word for each documented kind; `unknown` has none. */
const KIND_LABEL: Record<ActorKind, string | null> = {
  human: 'person',
  process: 'process',
  agent: 'agent',
  unknown: null,
};

export interface ActorView {
  kind: ActorKind;
  /** The chip text, or `null` for an unknown actor (show `text` alone). */
  kindLabel: string | null;
  /** The id, the agent's producer, or the raw string when unknown. */
  text: string;
  /** An agent's version, else `null`. */
  version: string | null;
  /** A plain-text rendering for tooltips and accessible names. */
  title: string;
  /** The actor string, unchanged. */
  raw: string;
}

/** How to show `raw`. A missing value is treated as the empty string. */
export function actorView(raw: string | null | undefined): ActorView {
  const a = parseActor(raw ?? '');
  const kindLabel = KIND_LABEL[a.kind] ?? null;
  const version = a.version ?? null;
  const text = kindLabel ? a.id : a.raw;
  const full = version ? `${text} ${version}` : text;
  const title = kindLabel ? `${kindLabel[0].toUpperCase()}${kindLabel.slice(1)}: ${full}` : text;
  return { kind: a.kind, kindLabel, text, version, title, raw: a.raw };
}

/** Whether `raw` is a `human:` actor — the trust-tier test (§5.3). */
export function isHumanActor(raw: string | null | undefined): boolean {
  return parseActor(raw ?? '').kind === 'human';
}

/** The DOM for `raw`, for surfaces built outside Svelte (hover cards). */
export function actorElement(raw: string | null | undefined): HTMLElement {
  const v = actorView(raw);
  const root = document.createElement('span');
  root.className = `actor actor-${v.kind}`;
  root.title = v.title;
  if (v.kindLabel) {
    const chip = document.createElement('span');
    chip.className = 'actor-kind';
    chip.textContent = v.kindLabel;
    root.append(chip);
  }
  const id = document.createElement('span');
  id.className = 'actor-id';
  id.textContent = v.text;
  root.append(id);
  if (v.version) {
    const ver = document.createElement('span');
    ver.className = 'actor-version';
    ver.textContent = v.version;
    root.append(ver);
  }
  return root;
}
