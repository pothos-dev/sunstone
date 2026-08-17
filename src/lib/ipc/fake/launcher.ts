// Launcher backing store (fake). The known-folder list persists in localStorage;
// the "which Bundle is open" marker uses sessionStorage so it survives the reload
// the launcher triggers but resets per fresh test context.

import type { KnownBundle } from '$lib/types';

/** localStorage key for the fake launcher's known-folder list. */
export const KNOWN_BUNDLES_KEY = 'sunstone:knownBundles';
/** sessionStorage key marking which Bundle the launcher opened this session. */
const FAKE_OPEN_KEY = 'sunstone:fakeOpenBundle';

/** True when the URL forces launcher mode (`?launcher=1`/`?launcher`). */
export function isLauncherForced(): boolean {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).has('launcher');
}

export function getFakeOpenBundle(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  return sessionStorage.getItem(FAKE_OPEN_KEY);
}

export function setFakeOpenBundle(path: string): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(FAKE_OPEN_KEY, path);
}

/** Display basename of a folder path (mirrors the Rust `display_name`). */
export function bundleName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * The seed known-folder list — two fixtures so the launcher shows a non-empty,
 * sorted list out of the box (for the screenshot + list-ordering test). Fixed
 * `lastOpened` values keep the order deterministic.
 */
export function seedKnownBundles(): KnownBundle[] {
  // Offsets from "now" (stamped once, then persisted) so the relative-time labels
  // read realistically; the descending order matches the assertions below.
  const now = Date.now();
  const min = 60_000;
  return [
    { path: '/home/user/Knowledge Base', name: 'Knowledge Base', lastOpened: now - 5 * min, exists: true },
    { path: '/home/user/Project Notes', name: 'Project Notes', lastOpened: now - 120 * min, exists: true },
    { path: '/home/user/Archive', name: 'Archive', lastOpened: now - 3 * 24 * 60 * min, exists: true },
  ];
}

/** Load the known-folder list (seeding on first use), sorted newest-first. */
export function loadKnownBundles(): KnownBundle[] {
  if (typeof localStorage === 'undefined') return seedKnownBundles();
  const raw = localStorage.getItem(KNOWN_BUNDLES_KEY);
  if (raw === null) {
    const seeded = seedKnownBundles();
    saveKnownBundles(seeded);
    return sortKnownBundles(seeded);
  }
  try {
    const parsed = JSON.parse(raw) as KnownBundle[];
    return sortKnownBundles(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

/** Persist the known-folder list verbatim. */
export function saveKnownBundles(list: KnownBundle[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(KNOWN_BUNDLES_KEY, JSON.stringify(list));
}

/** Sort newest-first (lastOpened desc, null last), tie-broken by name — mirrors Rust. */
export function sortKnownBundles(list: KnownBundle[]): KnownBundle[] {
  return [...list].sort(
    (a, b) =>
      (b.lastOpened ?? -Infinity) - (a.lastOpened ?? -Infinity) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
}

/** Stamp `path` as just-opened (adding it to the known list if new). */
export function touchKnownBundle(path: string): void {
  const list = loadKnownBundles().filter((b) => b.path !== path);
  const stamp = list.reduce((max, b) => Math.max(max, b.lastOpened ?? 0), 0) + 1000;
  list.push({ path, name: bundleName(path), lastOpened: stamp, exists: true });
  saveKnownBundles(list);
}
