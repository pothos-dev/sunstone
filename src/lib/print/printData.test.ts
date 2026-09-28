import { describe, expect, test } from 'bun:test';
import { printPageData, printUrl } from './printData';

const at = (query: string) => new URL(`https://example.test/${query}`);

describe('printUrl', () => {
  test('builds the exact preview URLs', () => {
    expect(printUrl('a b/c&d.md')).toBe('/?print=a%20b%2Fc%26d.md');
    expect(printUrl('x.md', true)).toBe('/?print=x.md&toolbar=1');
  });

  test('round-trips through printPageData', () => {
    for (const path of ['index.md', 'research/mistral.md', 'a b/ü?#&=+.md']) {
      for (const toolbar of [false, true]) {
        const url = new URL(printUrl(path, toolbar), 'https://example.test');
        expect(printPageData(url)).toEqual({ web: false, print: path, toolbar });
      }
    }
  });
});

describe('printPageData', () => {
  test('returns null when there is no print param', () => {
    expect(printPageData(at(''))).toBeNull();
    expect(printPageData(at('?toolbar=1'))).toBeNull();
  });

  test('extracts the print path and toolbar flag', () => {
    expect(printPageData(at('?print=research/mistral.md&toolbar=1'))).toEqual({
      web: false,
      print: 'research/mistral.md',
      toolbar: true,
    });
  });

  test('defaults toolbar to false when absent or not "1"', () => {
    expect(printPageData(at('?print=a.md'))?.toolbar).toBe(false);
    expect(printPageData(at('?print=a.md&toolbar=0'))?.toolbar).toBe(false);
  });

  test('detects print on the desktop index.html pathname (the print-window bug)', () => {
    // The Tauri print window loads `index.html?print=…`; the SPA client router
    // matches that against the catch-all route, so detection must be pathname-
    // independent.
    const url = new URL('https://example.test/index.html?print=notes/x.md&toolbar=1');
    expect(printPageData(url)).toEqual({
      web: false,
      print: 'notes/x.md',
      toolbar: true,
    });
  });

  test('treats an empty print value as present (not null)', () => {
    expect(printPageData(at('?print='))).toEqual({
      web: false,
      print: '',
      toolbar: false,
    });
  });
});
