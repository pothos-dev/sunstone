/**
 * Edits to the user's `config.json` (pure logic). The settings page records
 * one `ConfigEdit` per leaf the user changes; only those paths are written, so
 * keys the user wrote by hand (font `files`, a `$comment`, anything Sunstone
 * does not know) survive untouched and in their order.
 *
 * Rust owns the real write (`sunstone_native::settings`); this module is what
 * the live preview and the `fake` backend apply, and both sides pin the same
 * behaviour in their tests.
 */

import type { ConfigEdit } from '$lib/types';

/** The top-level keys the settings page may write. Anything else is the user's. */
export const SETTINGS_KEYS = ['theme', 'colorTheme', 'colors', 'fonts', 'defaults', 'keybindings'] as const;

export type ConfigObject = Record<string, unknown>;

export function isConfigObject(v: unknown): v is ConfigObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The value at `path`, or `undefined` when any step is missing or not an object. */
export function configValue(config: unknown, path: readonly string[]): unknown {
  let cur = config;
  for (const key of path) {
    if (!isConfigObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Whether an edit targets a key the settings page owns. */
export function isSettingsPath(path: readonly string[]): boolean {
  return path.length > 0 && path.every((k) => k !== '') && (SETTINGS_KEYS as readonly string[]).includes(path[0]);
}

/**
 * `config` with `edits` applied, as a new object (the input is not mutated).
 * A set creates missing parent objects (replacing a non-object in the way); an
 * edit without `value` removes the key and then every parent object the
 * removal left empty (`value: undefined` is a removal, which is also how it
 * crosses IPC: JSON drops the key). Existing keys keep their position; new keys append.
 */
export function applyConfigEdits(config: unknown, edits: readonly ConfigEdit[]): ConfigObject {
  const root: ConfigObject = isConfigObject(config) ? structuredClone(config) : {};
  for (const edit of edits) {
    if (edit.path.length === 0) continue;
    const parents: ConfigObject[] = [root];
    let cur = root;
    let missing = false;
    for (const key of edit.path.slice(0, -1)) {
      if (!isConfigObject(cur[key])) {
        if (edit.value === undefined) {
          missing = true;
          break;
        }
        cur[key] = {};
      }
      cur = cur[key] as ConfigObject;
      parents.push(cur);
    }
    const last = edit.path[edit.path.length - 1];
    if (edit.value !== undefined) {
      cur[last] = structuredClone(edit.value);
      continue;
    }
    if (missing || !(last in cur)) continue;
    delete cur[last];
    for (let i = parents.length - 1; i > 0 && Object.keys(parents[i]).length === 0; i--) {
      delete parents[i - 1][edit.path[i - 1]];
    }
  }
  return root;
}

/** The key a pending edit is stored under (one per leaf path). */
export function editKey(path: readonly string[]): string {
  return path.join('\u0000');
}

/**
 * The edit that sets (`{ value }`) or resets (`'reset'`) the leaf at `path`,
 * judged against `base` — the file as it will be once writes in flight land —
 * or `null` when there is nothing to write: the value is already there, or
 * the key to reset is already absent.
 */
export function planEdit(base: unknown, path: readonly string[], change: { value: unknown } | 'reset'): ConfigEdit | null {
  const current = configValue(base, path);
  if (change === 'reset') return current === undefined ? null : { path: [...path] };
  return JSON.stringify(current) === JSON.stringify(change.value) ? null : { path: [...path], value: change.value };
}

/** `pending` after recording the outcome of `planEdit` for `path`. */
export function withEdit(
  pending: ReadonlyMap<string, ConfigEdit>,
  path: readonly string[],
  edit: ConfigEdit | null,
): Map<string, ConfigEdit> {
  const next = new Map(pending);
  if (edit === null) next.delete(editKey(path));
  else next.set(editKey(path), edit);
  return next;
}

/** `pending` without the edits of a written `batch` (an edit replaced meanwhile stays). */
export function withoutWritten(
  pending: ReadonlyMap<string, ConfigEdit>,
  batch: ReadonlyMap<string, ConfigEdit>,
): Map<string, ConfigEdit> {
  const rest = new Map(pending);
  for (const [k, edit] of batch) if (rest.get(k) === edit) rest.delete(k);
  return rest;
}
