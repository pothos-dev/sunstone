// Pure mutation rules for the Properties panel (extracted from
// Properties.svelte so they can be unit-tested). Every function takes the
// current `Property[]` and returns a NEW array — or `null` when the edit is a
// no-op / revert and the component should leave the properties untouched.
//
// Rows are addressed by their positional id (array index): `properties` is
// rebuilt wholesale on every change with document order preserved, so the
// index never desyncs from its prop (see Properties.svelte).

import { renameProperty, type Property } from '$lib/frontmatter';

/** Append a new property (the "+ Text" / "+ List" add). */
export function appendProperty(properties: Property[], prop: Property): Property[] {
  return [...properties, prop];
}

/**
 * Commit a key rename for the row at `id` (blur / Enter).
 *
 * `draft` is the in-progress key text, or `undefined` when the input still
 * shows the live key. `isNew` marks a freshly added row awaiting its first key
 * commit.
 *
 * A freshly added row has no prior key to revert to (unlike a rename). So both
 * rejection cases DISCARD the row: an empty key, and a duplicate key.
 * Discarding is the least-surprising consistent rule — it never commits under
 * the duplicate name and leaves no half-edited row lingering after blur (no
 * focus-fighting). The user simply re-adds.
 *
 * For an existing row, an empty, unchanged, or duplicate key REVERTS (returns
 * `null`: keep the live properties as they are).
 */
export function commitKeyEdit(
  properties: Property[],
  id: number,
  draft: string | undefined,
  isNew: boolean,
): Property[] | null {
  const prop = properties[id];
  if (!prop) return null;
  const next = (draft ?? prop.key).trim();
  const duplicate = properties.some((p, i) => i !== id && p.key === next);

  if (isNew) {
    if (next === '' || duplicate) {
      return properties.filter((_, i) => i !== id);
    }
    return properties.map((p, i) => (i === id ? renameProperty(p, next) : p));
  }

  if (next === '' || next === prop.key) return null; // empty or no-op -> revert
  if (duplicate) return null; // duplicate key -> revert
  return properties.map((p, i) => (i === id ? renameProperty(p, next) : p));
}

/** Remove the property at row `id`. */
export function removePropertyAt(properties: Property[], id: number): Property[] {
  return properties.filter((_, i) => i !== id);
}

/** Replace the value of the scalar property at row `id`. */
export function setScalarAt(properties: Property[], id: number, value: string): Property[] {
  return properties.map((p, i) => (i === id ? { ...p, scalar: value } : p));
}

/** Set the items of the list property at row `id`. */
export function setListAt(properties: Property[], id: number, items: string[]): Property[] {
  return properties.map((p, i) => (i === id ? { ...p, list: items } : p));
}

/**
 * Add a chip to the list at row `id`: append the trimmed `draft` to `current`.
 * Returns `null` when the trimmed draft is empty (nothing to add).
 */
export function addChipAt(
  properties: Property[],
  id: number,
  current: string[],
  draft: string,
): Property[] | null {
  const trimmed = draft.trim();
  if (trimmed === '') return null;
  return setListAt(properties, id, [...current, trimmed]);
}

/** Remove the chip at `index` from the list at row `id`. */
export function removeChipAt(
  properties: Property[],
  id: number,
  current: string[],
  index: number,
): Property[] {
  const next = current.slice();
  next.splice(index, 1);
  return setListAt(properties, id, next);
}
