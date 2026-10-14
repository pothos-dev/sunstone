import { describe, expect, test } from 'bun:test';
import { metaPillView } from './metaPill';
import type { Trust } from '$lib/wasm/exports';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

function trust(over: Partial<Trust> = {}): Trust {
  return {
    generated: { by: 'reference_agent/gemini-2.5-pro', at: '2026-10-11T12:00:00Z', iso: true },
    legacy: false,
    verified: [{ by: 'human:ahormati', at: '2026-10-13T12:00:00Z', iso: true }],
    tier: 'humanReviewed',
    lastVerified: '2026-10-13T12:00:00Z',
    trustKeys: true,
    ...over,
  };
}

describe('metaPillView: segments', () => {
  test('no metadata, no pill', () => {
    expect(metaPillView({ trust: null, lifecycle: null, sourceCount: 0 }, NOW)).toBeNull();
  });

  test('a stable, not-stale lifecycle alone shows no pill', () => {
    const v = metaPillView({ trust: null, lifecycle: { status: 'stable', staleAfter: '2027-01-01T00:00:00Z' }, sourceCount: 0 }, NOW);
    expect(v).toBeNull();
  });

  test('all three segments, Reviewed in accent, stale in danger', () => {
    const v = metaPillView(
      { trust: trust(), lifecycle: { status: 'stable', staleAfter: '2026-10-01T00:00:00Z' }, sourceCount: 3 },
      NOW,
    )!;
    expect(v.trust).toEqual({ label: 'Reviewed', tier: 'humanReviewed', accent: true, hint: expect.any(String) });
    expect(v.sources).toBe(3);
    expect(v.lifecycle).toEqual({ label: 'stale', danger: true });
  });

  test('the tier labels', () => {
    const label = (tier: Trust['tier']) => metaPillView({ trust: trust({ tier }), lifecycle: null, sourceCount: 0 }, NOW)!.trust;
    expect(label('machineConfirmed')).toMatchObject({ label: 'Confirmed', accent: false });
    expect(label('unverified')).toMatchObject({ label: 'Unverified', accent: false });
  });

  test('a non-stable status shows when not stale; an unrecognised one does not', () => {
    const lc = (status: string) => metaPillView({ trust: null, lifecycle: { status, staleAfter: null }, sourceCount: 1 }, NOW)!.lifecycle;
    expect(lc('draft')).toEqual({ label: 'draft', danger: false });
    expect(lc('deprecated')).toEqual({ label: 'deprecated', danger: false });
    expect(lc('stable')).toBeNull();
    expect(lc('wip')).toBeNull();
  });

  test('a legacy timestamp alone has no tier segment', () => {
    const legacy = trust({ legacy: true, trustKeys: false, verified: [], tier: 'unverified', generated: { by: null, at: '2026-06-15T10:00:00Z', iso: true } });
    expect(metaPillView({ trust: legacy, lifecycle: null, sourceCount: 0 }, NOW)).toBeNull();
    expect(metaPillView({ trust: legacy, lifecycle: null, sourceCount: 2 }, NOW)!.trust).toBeNull();
  });
});

describe('metaPillView: popover', () => {
  test('trust rows carry the actor and the relative time', () => {
    const p = metaPillView({ trust: trust(), lifecycle: null, sourceCount: 0 }, NOW)!.popover;
    expect(p.trust?.tier).toEqual({ label: 'Human-reviewed', tier: 'humanReviewed', hint: expect.any(String) });
    expect(p.trust?.generated).toMatchObject({ actor: 'reference_agent/gemini-2.5-pro', at: '2026-10-11T12:00:00Z', time: { text: '3 days ago' } });
    expect(p.trust?.verified).toHaveLength(1);
    expect(p.trust?.verified[0]).toMatchObject({ actor: 'human:ahormati', time: { text: 'yesterday' } });
  });

  test('a non-ISO time is kept as written', () => {
    const t = trust({ verified: [{ by: 'process:nightly', at: 'soon', iso: false }] });
    const row = metaPillView({ trust: t, lifecycle: null, sourceCount: 0 }, NOW)!.popover.trust!.verified[0];
    expect(row).toMatchObject({ at: 'soon', time: null });
  });

  test('lifecycle: status with its meaning, stale since / stale after', () => {
    const stale = metaPillView({ trust: null, lifecycle: { status: 'deprecated', staleAfter: '2026-10-11T12:00:00Z' }, sourceCount: 0 }, NOW)!;
    expect(stale.popover.lifecycle).toMatchObject({
      status: 'deprecated',
      meaning: expect.stringContaining('no longer current'),
      stale: true,
      staleAfter: { at: '2026-10-11T12:00:00Z', time: { text: '3 days ago' } },
    });
    const later = metaPillView({ trust: null, lifecycle: { status: 'draft', staleAfter: '2026-10-28T12:00:00Z' }, sourceCount: 0 }, NOW)!;
    expect(later.popover.lifecycle).toMatchObject({ stale: false, staleAfter: { time: { text: 'in 2 weeks' } } });
  });

  test('sources count', () => {
    expect(metaPillView({ trust: trust(), lifecycle: null, sourceCount: 0 }, NOW)!.popover.sources).toBe(0);
    expect(metaPillView({ trust: null, lifecycle: null, sourceCount: 4 }, NOW)!.popover.sources).toBe(4);
  });
});
