import { describe, expect, test } from 'bun:test';
import { bundleRootLabel } from './bundleRootLabel';

describe('bundleRootLabel', () => {
  test('nothing to show before the index loads', () => {
    expect(bundleRootLabel('', null)).toBeNull();
  });

  test('the root reads as a bundle-absolute path', () => {
    expect(bundleRootLabel('', 'openedFolder')?.text).toBe('/');
    expect(bundleRootLabel('docs/kb', 'indexChain')?.text).toBe('/docs/kb');
  });

  test('an override is distinguishable from every detected rung', () => {
    const set = bundleRootLabel('kb', 'override')!;
    expect(set.overridden).toBe(true);
    expect(set.title).toContain('set by you');
    expect(set.title).toContain('Use Detected Bundle Root');
    for (const rung of ['marker', 'indexChain', 'gitToplevel', 'openedFolder'] as const) {
      const found = bundleRootLabel('kb', rung)!;
      expect(found.overridden).toBe(false);
      expect(found.title).toContain('detected');
    }
  });
});
