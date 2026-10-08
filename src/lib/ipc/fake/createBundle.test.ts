// The fake's half of "Create Bundle" (ov-8): declaring the store's root
// `index.md` through the shared `okf_marker::declare_okf_version` (wasm,
// preloaded by bunfig.toml). The writer's goldens live in
// `crates/sunstone-shared/src/okf_marker.rs`; these pin the fake's seam over it.
import { afterEach, describe, expect, test } from 'bun:test';
import { declareRootIndex } from './createBundle';
import { okfMarkers } from './links';
import { FILES } from './store';

const snapshot = { ...FILES };

afterEach(() => {
  for (const key of Object.keys(FILES)) if (!(key in snapshot)) delete FILES[key];
  for (const [key, value] of Object.entries(snapshot)) FILES[key] = value;
});

describe('declareRootIndex', () => {
  test('adds the marker to the existing root index, keeping its keys and body', () => {
    const before = FILES['index.md'];
    expect(declareRootIndex('New Bundle')).toBe(true);
    const after = FILES['index.md'];
    expect(after.startsWith('---\nokf_version: "0.2"\n')).toBe(true);
    expect(after.replace('okf_version: "0.2"\n', '')).toBe(before);
    expect(okfMarkers()).toEqual([{ indexPath: 'index.md', okfVersion: '0.2' }]);
  });

  test('never touches a non-root index.md', () => {
    const nested = Object.keys(FILES).filter((p) => p.endsWith('/index.md'));
    expect(nested.length).toBeGreaterThan(0);
    declareRootIndex('New Bundle');
    for (const p of nested) expect(FILES[p]).toBe(snapshot[p]);
  });

  test('creates a root index.md when there is none', () => {
    delete FILES['index.md'];
    expect(declareRootIndex('New Bundle')).toBe(true);
    expect(FILES['index.md']).toBe('---\nokf_version: "0.2"\n---\n\n# New Bundle\n');
  });

  test('leaves an existing declaration alone, even of another version', () => {
    FILES['index.md'] = '---\nokf_version: "0.1"\n---\n# Old\n';
    expect(declareRootIndex('New Bundle')).toBe(false);
    expect(FILES['index.md']).toBe('---\nokf_version: "0.1"\n---\n# Old\n');
  });
});
