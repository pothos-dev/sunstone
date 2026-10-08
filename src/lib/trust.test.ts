import { describe, expect, test } from 'bun:test';
import { trustOf } from '$lib/wasm/exports';
import { trustLineHtml } from './trust';
import { formatYaml } from './frontmatter';

// The trust line markup. The native render's `render/trust.rs` asserts the
// same goldens, so the desktop editor, the fake and the web viewer agree.

describe('trustOf (shared Rust over wasm)', () => {
  test('tier derivation from verified alone', () => {
    expect(trustOf('generated: { by: human:a, at: 2026-06-20T22:53:05Z }\n')?.tier).toBe('unverified');
    expect(trustOf('verified:\n  - { by: process:p }\n  - { by: a/1 }\n')?.tier).toBe('machineConfirmed');
    expect(trustOf('verified:\n  - { by: process:p }\n  - { by: human:x }\n')?.tier).toBe('humanReviewed');
    expect(trustOf('verified: []\n')?.tier).toBe('unverified');
  });

  test('a bare verified mapping is a one-element list', () => {
    const t = trustOf('verified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }\n')!;
    expect(t.verified).toEqual([{ by: 'human:ahormati', at: '2026-06-25T09:00:00Z', iso: true }]);
    expect(t.tier).toBe('humanReviewed');
  });

  test('formatting a bare verified mapping keeps it one event', () => {
    for (const yaml of [
      'type: x\nverified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }',
      'type: x\nverified:\n    by: human:ahormati\n    at: 2026-06-25T09:00:00Z',
    ]) {
      const formatted = formatYaml(yaml) ?? yaml;
      expect(trustOf(formatted)).toEqual(trustOf(yaml));
      expect(trustOf(formatted)!.verified).toHaveLength(1);
    }
  });

  test('legacy timestamp is the generation time', () => {
    const t = trustOf('type: x\ntimestamp: 2026-06-15T10:00:00Z\n')!;
    expect(t.legacy).toBe(true);
    expect(t.trustKeys).toBe(false);
    expect(t.generated).toEqual({ by: null, at: '2026-06-15T10:00:00Z', iso: true } as never);
  });

  test('no trust keys, no trust', () => {
    expect(trustOf('type: x\n')).toBeNull();
  });
});

describe('trustLineHtml', () => {
  test('nothing for a Concept without trust keys', () => {
    expect(trustLineHtml('type: x\ntitle: y\n')).toBe('');
  });

  test('generated and verified, human-reviewed', () => {
    const yaml =
      'generated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-20T22:53:05Z }\n' +
      'verified:\n  - { by: human:ahormati, at: 2026-06-25T09:00:00Z }\n  - { by: process:nightly, at: soon }\n';
    expect(trustLineHtml(yaml)).toBe(GOLDEN_FULL);
  });

  test('generated without by degrades visibly; unverified', () => {
    expect(trustLineHtml('generated:\n  at: 2026-06-20\n')).toBe(GOLDEN_NO_BY);
  });

  test('legacy timestamp: generation time, no tier', () => {
    expect(trustLineHtml('timestamp: 2026-06-15T10:00:00Z\n')).toBe(GOLDEN_LEGACY);
  });

  test('actor text is escaped', () => {
    expect(trustLineHtml('verified: { by: "<b>x" }\n')).toContain('<span class="actor-id">&lt;b&gt;x</span>');
  });
});

export const GOLDEN_FULL =
  '<div class="trust trust-human-reviewed" data-testid="trust">' +
  '<span class="trust-tier" title="Trust tier (OKF §5.3): confirmed by a person">Human-reviewed</span> ' +
  '<span class="trust-generated"><span class="trust-label">Generated</span> by ' +
  '<span class="actor actor-agent" title="Agent: reference_agent gemini-2.5-pro"><span class="actor-kind">agent</span>' +
  '<span class="actor-id">reference_agent</span><span class="actor-version">gemini-2.5-pro</span></span> ' +
  '<time class="trust-at" datetime="2026-06-20T22:53:05Z" title="2026-06-20T22:53:05Z">2026-06-20</time></span> ' +
  '<span class="trust-verified"><span class="trust-label">Verified</span> ' +
  '<span class="trust-event"><span class="actor actor-human" title="Person: ahormati"><span class="actor-kind">person</span>' +
  '<span class="actor-id">ahormati</span></span> ' +
  '<time class="trust-at" datetime="2026-06-25T09:00:00Z" title="2026-06-25T09:00:00Z">2026-06-25</time></span> ' +
  '<span class="trust-event"><span class="actor actor-process" title="Process: nightly"><span class="actor-kind">process</span>' +
  '<span class="actor-id">nightly</span></span> <time class="trust-at" title="soon">soon</time></span></span></div>';

export const GOLDEN_NO_BY =
  '<div class="trust trust-unverified" data-testid="trust">' +
  '<span class="trust-tier" title="Trust tier (OKF §5.3): nobody has confirmed this Concept">Unverified</span> ' +
  '<span class="trust-generated"><span class="trust-label">Generated</span> ' +
  '<span class="trust-missing" title="`generated` has no `by` (OKF §5.2)">by unknown</span> ' +
  '<time class="trust-at" title="2026-06-20">2026-06-20</time></span></div>';

export const GOLDEN_LEGACY =
  '<div class="trust" data-testid="trust">' +
  '<span class="trust-generated" title="From the legacy `timestamp` (OKF §13.1)"><span class="trust-label">Generated</span> ' +
  '<time class="trust-at" datetime="2026-06-15T10:00:00Z" title="2026-06-15T10:00:00Z">2026-06-15</time></span></div>';
