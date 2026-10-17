// Unit tests for D2's slot-class → app-palette stylesheet (dr-3).
import { describe, expect, test } from 'bun:test';
import {
  D2_PALETTE,
  D2_ROLE_RULES,
  D2_SCOPE,
  D2_SLOTS,
  D2_SLOT_PROPERTIES,
  d2Stylesheet,
} from './d2Theme';

const rules = d2Stylesheet().split('\n');

/** Specificity (ids, classes, types) of a selector, enough for ours and D2's. */
function specificity(selector: string): [number, number, number] {
  // `:is(a, b)` counts as its most specific argument; all of ours are one class.
  const flat = selector.replace(/:is\(([^)]*)\)/g, (_, args: string) => args.split(',')[0].trim());
  const classes = (flat.match(/\.[\w-]+|:(?!is)[\w-]+/g) ?? []).length;
  const types = (flat.match(/(^|[\s>+~])[a-z][\w-]*/g) ?? []).length;
  return [0, classes, types];
}

function outranks(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

describe('D2 palette', () => {
  test('maps every D2 slot to an app custom property', () => {
    for (const slot of D2_SLOTS) {
      expect(D2_PALETTE[slot]).toMatch(/var\(--[\w-]+\)/);
    }
  });

  test('mirrors mermaid: labels on --text, edge labels muted, shapes on the elevated surface', () => {
    expect(D2_PALETTE.N1).toBe('var(--text)');
    expect(D2_PALETTE.N2).toBe('var(--text-muted)');
    expect(D2_PALETTE.B6).toBe('var(--bg-elevated)');
    expect(D2_PALETTE.B4).toBe('var(--bg-sunken)');
  });

  test('never a literal colour, so a theme flip re-resolves every slot', () => {
    for (const slot of D2_SLOTS) expect(D2_PALETTE[slot]).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });
});

describe('d2Stylesheet', () => {
  test('one rule per slot and property, in the slot class D2 emits', () => {
    for (const slot of D2_SLOTS) {
      for (const property of D2_SLOT_PROPERTIES) {
        expect(rules).toContain(
          `${D2_SCOPE} .${property}-${slot} { ${property}: ${D2_PALETTE[slot]}; }`,
        );
      }
    }
    expect(rules).toHaveLength(D2_SLOTS.length * D2_SLOT_PROPERTIES.length + D2_ROLE_RULES.length);
  });

  test('every rule is scoped to D2 diagrams on both surfaces', () => {
    for (const rule of rules) expect(rule.startsWith(`${D2_SCOPE} `)).toBe(true);
    expect(D2_SCOPE).toContain('.cm-d2');
    expect(D2_SCOPE).toContain('.web-d2');
  });

  test("every rule out-ranks D2's embedded `.d2-<hash> .fill-X`", () => {
    const d2Embedded = specificity('.d2-2922646921 .fill-B6');
    for (const rule of rules) {
      const selector = rule.slice(0, rule.indexOf(' {'));
      expect(outranks(specificity(selector), d2Embedded)).toBe(true);
    }
  });

  test('only slot classes are targeted, so authored literal colours are left alone', () => {
    for (const rule of rules) {
      expect(rule).not.toMatch(/\[(fill|stroke|style)/);
      expect(rule).not.toContain('!important');
    }
  });

  test('connections take the muted foreground; the background rect goes transparent', () => {
    const css = d2Stylesheet();
    expect(css).toContain(`${D2_SCOPE} .connection.stroke-B1 { stroke: var(--text-muted); }`);
    expect(css).toContain(`${D2_SCOPE} .connection.fill-B1 { fill: var(--text-muted); }`);
    expect(css).toContain(`${D2_SCOPE} > rect.fill-N7:first-child { fill: transparent; }`);
  });
});
