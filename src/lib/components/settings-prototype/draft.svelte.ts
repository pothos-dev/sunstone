// PROTOTYPE — the settings draft every variant edits. Throwaway.
//
// Holds the config as loaded plus the user's EDITS; `config` is the two
// combined (what Save would write). Edits preview live (theme mode, colours,
// fonts) but nothing is persisted: Save only folds the edits into `original`
// in memory, so a reload is a clean slate.

import { backend } from '$lib/ipc';
import { theme, type ThemeMode } from '$lib/state/theme.svelte';
import { APPEARANCE_STYLE_ID, appearanceCss } from '$lib/state/appearance';
import {
  appearanceInput,
  applyEdits,
  COMMANDS,
  getPath,
  isObject,
  SEED_CONFIG,
  UNSET,
  type Edit,
  type Json,
  type JsonObject,
} from './model';

class SettingsDraft {
  /** `config.json` as loaded (or the seed, when the backend has none). */
  original = $state.raw<JsonObject>({});
  /** path → new value, or UNSET to remove the key. Only what the user touched. */
  edits = $state.raw(new Map<string, Edit>());
  loaded = $state(false);

  config = $derived(applyEdits(this.original, this.edits));
  dirty = $derived(this.edits.size > 0);

  #savedMode: ThemeMode = 'system';
  #savedCss = '';

  async load(): Promise<void> {
    if (this.loaded) return;
    let raw: unknown = null;
    try {
      raw = await backend.loadAppearance();
    } catch {
      // keep the seed
    }
    this.original = isObject(raw) && Object.keys(raw).length > 0 ? (raw as JsonObject) : structuredClone(SEED_CONFIG);
    const mode = this.original.theme;
    if (mode === 'light' || mode === 'dark' || mode === 'system') theme.mode = mode;
    this.#savedMode = theme.mode;
    this.#savedCss = document.getElementById(APPEARANCE_STYLE_ID)?.textContent ?? '';
    this.loaded = true;
    this.preview();
  }

  /** The value in effect for `path` (edited, else loaded), or `undefined`. */
  get(path: string): Json | undefined {
    return getPath(this.config, path);
  }

  /** Whether `path` (or anything under it) is edited in this draft. */
  isEdited(path: string): boolean {
    for (const k of this.edits.keys()) if (k === path || k.startsWith(path + '.')) return true;
    return false;
  }

  /** Whether config.json sets `path` at all (i.e. it differs from the built-in default). */
  isSet(path: string): boolean {
    return this.get(path) !== undefined;
  }

  /**
   * Record an edit. Setting a key back to what config.json already holds drops
   * the edit, so toggling something twice writes nothing.
   */
  set(path: string, value: Json): void {
    const next = new Map(this.edits);
    if (JSON.stringify(getPath(this.original, path)) === JSON.stringify(value)) next.delete(path);
    else next.set(path, value);
    this.edits = next;
    this.preview();
  }

  /** Reset to the built-in default: remove the key from config.json. */
  unset(path: string): void {
    const next = new Map(this.edits);
    for (const k of next.keys()) if (k.startsWith(path + '.')) next.delete(k);
    if (getPath(this.original, path) === undefined) next.delete(path);
    else next.set(path, UNSET);
    this.edits = next;
    this.preview();
  }

  binding(id: string): string {
    const v = this.get(`keybindings.${id}`);
    return typeof v === 'string' ? v : (COMMANDS.find((c) => c.id === id)?.def ?? '');
  }

  setBinding(id: string, chord: string): void {
    const def = COMMANDS.find((c) => c.id === id)?.def;
    if (chord === def) this.unset(`keybindings.${id}`);
    else this.set(`keybindings.${id}`, chord);
  }

  save(): void {
    this.original = this.config;
    this.edits = new Map();
    this.#savedMode = theme.mode;
    this.#savedCss = document.getElementById(APPEARANCE_STYLE_ID)?.textContent ?? '';
  }

  discard(): void {
    this.edits = new Map();
    theme.mode = this.#savedMode;
    this.#writeCss(this.#savedCss);
  }

  /** Apply the draft to the running app: theme mode, colours, fonts. */
  preview(): void {
    const mode = this.get('theme');
    theme.mode = mode === 'light' || mode === 'dark' ? mode : 'system';
    const raw = appearanceInput(this.config);
    this.#writeCss(
      appearanceCss(raw, { isColor: (v) => CSS.supports('color', v), fontUrl: (src) => backend.fontUrl(src) }),
    );
  }

  #writeCss(css: string): void {
    let style = document.getElementById(APPEARANCE_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = APPEARANCE_STYLE_ID;
      document.head.append(style);
    }
    style.textContent = css;
  }
}

export const draft = new SettingsDraft();
