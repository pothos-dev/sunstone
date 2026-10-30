/**
 * Settings store: the user's `config.json` and the settings page's changes to
 * it. Desktop only — the web and `sunstone serve` have no settings page
 * (`SETTINGS_EDITABLE`), and there the store stays empty and every derived
 * value is its default.
 *
 * Every change is saved on its own, shortly after it is made (no Save button):
 * `set`/`reset` record a `ConfigEdit` for that one leaf and a debounced flush
 * hands the batch to `Backend.saveConfigEdits`, which changes only those paths
 * in the file. `config` is the file as loaded with the pending edits applied,
 * so the app previews a change before it is written.
 */

import type { Backend } from '$lib/ipc/backend';
import { servedDesktop } from '$lib/ipc/served';
import { errMessage } from '$lib/errors';
import { createDebouncer } from '$lib/debounce';
import { serialQueue } from '$lib/editor/serialQueue';
import type { ConfigEdit } from '$lib/types';
import {
  applyConfigEdits,
  configValue,
  isConfigObject,
  planEdit,
  withEdit,
  withoutWritten,
  type ConfigObject,
} from '$lib/settings/configEdits';
import { resolveKeybindings, type Keybindings } from '$lib/settings/keybindings';
import { resolvePanelDefaults, type PanelDefaults } from '$lib/settings/panelDefaults';
import type { ThemeMode } from './theme.svelte';

/** Whether this build has a settings page (the desktop app, not web or `sunstone serve`). */
export const SETTINGS_EDITABLE = !__SUNSTONE_WEB__ && !servedDesktop;

const SAVE_DEBOUNCE_MS = 300;

class SettingsStore {
  /** `config.json` as last loaded or saved. */
  saved = $state.raw<ConfigObject>({});
  /** Edits not yet written, one per leaf path. */
  pending = $state.raw<ReadonlyMap<string, ConfigEdit>>(new Map());
  /** The batch being written right now (already part of `pending`). */
  #inflight: readonly ConfigEdit[] = [];
  loaded = $state(false);
  /** The last save failure, shown on the settings page; cleared by the next success. */
  error = $state<string | null>(null);

  /** The effective config: `saved` with `pending` applied. */
  config = $derived(applyConfigEdits(this.saved, [...this.pending.values()]));
  themeMode = $derived<ThemeMode>(parseThemeMode(this.config.theme));
  keybindings = $derived<Keybindings>(resolveKeybindings(this.config.keybindings));
  panelDefaults = $derived<PanelDefaults>(resolvePanelDefaults(this.config.defaults));

  #backend: Backend | null = null;
  #enqueue = serialQueue();
  #debouncer = createDebouncer(() => void this.flush(), SAVE_DEBOUNCE_MS);

  /** Read `config.json` once. Resolves (to defaults) even when it is missing or unreadable. */
  async load(backend: Backend): Promise<void> {
    this.#backend = backend;
    if (!SETTINGS_EDITABLE) {
      this.loaded = true;
      return;
    }
    try {
      const raw = await backend.loadConfig();
      this.saved = isConfigObject(raw) ? raw : {};
    } catch {
      this.saved = {};
    }
    this.loaded = true;
  }

  /** The effective value at `path`, or `undefined` when unset. */
  get(path: readonly string[]): unknown {
    return configValue(this.config, path);
  }

  /** Whether `config.json` (with pending edits) sets `path`, i.e. it is not the built-in default. */
  isSet(path: readonly string[]): boolean {
    return this.get(path) !== undefined;
  }

  /** Set the leaf at `path`. Setting it to what the file already holds drops the edit. */
  set(path: readonly string[], value: unknown): void {
    this.#record(path, { value });
  }

  /** Back to the built-in default: remove the leaf from `config.json`. */
  reset(path: readonly string[]): void {
    this.#record(path, 'reset');
  }

  #record(path: readonly string[], change: { value: unknown } | 'reset'): void {
    // Judged against the file as it will be once a write in flight lands, so
    // undoing a change mid-write is recorded rather than dropped.
    const base = this.#inflight.length > 0 ? applyConfigEdits(this.saved, this.#inflight) : this.saved;
    this.pending = withEdit(this.pending, path, planEdit(base, path, change));
    this.#debouncer.schedule();
  }

  /** Write every pending edit now. Safe to call when nothing is pending. */
  flush(): Promise<void> {
    this.#debouncer.cancel();
    return this.#enqueue(async () => {
      const batch = this.pending;
      if (batch.size === 0 || this.#backend === null) return;
      const edits = [...batch.values()];
      this.#inflight = edits;
      try {
        await this.#backend.saveConfigEdits(edits);
      } catch (e) {
        this.error = errMessage(e);
        return;
      } finally {
        this.#inflight = [];
      }
      this.error = null;
      this.saved = applyConfigEdits(this.saved, edits);
      // Keep edits made while the write was in flight.
      this.pending = withoutWritten(this.pending, batch);
    });
  }
}

function parseThemeMode(v: unknown): ThemeMode {
  return v === 'light' || v === 'dark' ? v : 'system';
}

export const settings = new SettingsStore();
