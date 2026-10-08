// The Explorer's Bundle-root indicator (ov-7), as pure data: which folder is
// the root, which rung of the ladder found it, and whether the user set it.
// `App.svelte` renders it in the Explorer header; the root itself comes from
// the wasm `BundleIndex` (`indexStore.bundleRoot()` / `rootRung()`).

import type { RootRung } from '$lib/types';

export interface BundleRootLabel {
  /** The root as a bundle-absolute path: `/` for the opened folder, `/docs`. */
  text: string;
  /** Hover text: the root, how it was found, and how to change it. */
  title: string;
  /** True when the user set the root (an override), false when detected. */
  overridden: boolean;
}

const HOW: Record<RootRung, string> = {
  override: 'set by you',
  marker: 'detected: its index.md declares okf_version',
  indexChain: 'detected: the outermost folder with an index.md',
  gitToplevel: 'detected: the git repository root',
  openedFolder: 'detected: nothing marks a root, so /links resolve from each Concept’s folder',
};

/** The indicator for a root at `dir` found by `rung`, or `null` before the index loads. */
export function bundleRootLabel(dir: string, rung: RootRung | null): BundleRootLabel | null {
  if (rung === null) return null;
  const text = dir === '' ? '/' : `/${dir}`;
  const change =
    rung === 'override'
      ? 'Right-click a folder to move it, or choose “Use Detected Bundle Root”.'
      : 'Right-click a folder to set the root yourself.';
  return { text, title: `Bundle root ${text} (${HOW[rung]}). ${change}`, overridden: rung === 'override' };
}
