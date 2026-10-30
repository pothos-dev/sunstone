// The fake backend's `config.json`: one localStorage entry a spec can seed (and
// read back), standing in for the user's config file. `loadAppearance` and
// `loadConfig` both read it; `saveConfigEdits` writes it the way the Rust
// side does (`sunstone_native::settings`): only the edited paths change, a
// non-settings path refuses the whole batch, and a corrupt entry is never
// overwritten.

import type { ConfigEdit } from '$lib/types';
import { applyConfigEdits, isConfigObject, isSettingsPath } from '$lib/settings/configEdits';

/** localStorage key a spec seeds with a `config.json`-shaped object. */
export const FAKE_CONFIG_KEY = 'sunstone:fakeAppearance';

/** The stored config as parsed JSON (any shape), or `null` when absent or corrupt. */
export function readFakeConfig(): unknown {
  if (typeof localStorage === 'undefined') return null;
  try {
    return JSON.parse(localStorage.getItem(FAKE_CONFIG_KEY) ?? 'null');
  } catch {
    return null;
  }
}

/** The stored config when it is a JSON object, else `null`. */
export function loadFakeConfig(): unknown {
  const raw = readFakeConfig();
  return isConfigObject(raw) ? raw : null;
}

/** Apply `edits` to the stored config; rejects on a bad path or a stored non-object. */
export function saveFakeConfigEdits(edits: readonly ConfigEdit[]): void {
  const bad = edits.find((e) => !isSettingsPath(e.path));
  if (bad) throw new Error(`not a settings path: ${JSON.stringify(bad.path)}`);
  const text = typeof localStorage === 'undefined' ? null : localStorage.getItem(FAKE_CONFIG_KEY);
  let current: unknown = null;
  if (text !== null && text.trim() !== '') {
    try {
      current = JSON.parse(text);
    } catch {
      throw new Error('config.json is not valid JSON; fix it by hand first');
    }
    if (!isConfigObject(current)) throw new Error('config.json is not a JSON object; fix it by hand first');
  }
  localStorage.setItem(FAKE_CONFIG_KEY, JSON.stringify(applyConfigEdits(current, edits), null, 2));
}
