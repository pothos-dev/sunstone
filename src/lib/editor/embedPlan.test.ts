// Unit tests for the pure Embed planner (ADR-0010). Run with `bun test src/lib`.
//
// Deliberately wasm-FREE: the planner takes `classify` / `isImage` / `resolve` /
// `url` as callbacks, so the placement predicate, the cursor-overlap skip, the
// size->CSS mapping and the widget key are all pinned over plain strings without
// a built `pkg/`. A real `Text` from `@codemirror/state` stands in for the
// document, since `EmbedDoc` is exactly the slice of it the planner reads.
//
// The UTF-16 offset conversion itself is Rust's (`scan_embeds_utf16` in
// `crates/sunstone-shared/src/embed.rs`); what is pinned HERE is that the
// planner is offset-transparent — hand it UTF-16 offsets over a document with
// non-ASCII text and the decoration lands on the Embed.
import { describe, expect, test } from 'bun:test';
import { Text } from '@codemirror/state';
import type { Embed, EmbedTargetKind } from '$lib/wasm/exports';
import {
  embedSizeCss,
  embedWidgetKey,
  isAloneOnLine,
  overlapsSelection,
  planEmbeds,
  type EmbedPlanOptions,
} from './embedPlan';

/** A minimal `Embed`, as the kernel would report it (UTF-16 offsets). */
function embed(partial: Partial<Embed> & { from: number; to: number }): Embed {
  return {
    target: 'a.png',
    alt: 'a.png',
    width: null,
    height: null,
    kind: 'path',
    ...partial,
  } as Embed;
}

/** Find `needle` in `doc` and build the Embed spanning it. */
function embedIn(doc: string, needle: string, partial: Partial<Embed> = {}): Embed {
  const from = doc.indexOf(needle);
  if (from < 0) throw new Error(`not in doc: ${needle}`);
  return embed({ from, to: from + needle.length, ...partial });
}

/** The classifier's scheme test, inlined (the wasm-degraded path's twin). */
function classify(target: string): EmbedTargetKind {
  const t = target.trim();
  if (/^data:/i.test(t)) return 'data';
  if (/^https?:/i.test(t)) return 'remote';
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return 'otherScheme';
  return 'local';
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i;

function options(over: Partial<EmbedPlanOptions> = {}): EmbedPlanOptions {
  return {
    reading: false,
    selection: [],
    classify,
    isImage: (t) => IMAGE.test(t),
    resolve: (e) => (e.target.includes('missing') ? null : `assets/${e.target}`),
    url: (p) => `asset://${p}`,
    ...over,
  };
}

describe('isAloneOnLine', () => {
  const line = { from: 10, to: 30, text: '  ![a](x.png)       ' };

  test('an Embed spanning the line modulo whitespace is alone', () => {
    expect(isAloneOnLine(line, 12, 23)).toBe(true);
  });

  test('an Embed with text beside it is not alone', () => {
    const l = { from: 0, to: 20, text: 'see ![a](x.png) too' };
    expect(isAloneOnLine(l, 4, 17)).toBe(false);
  });

  test('an Embed running past the line end is never alone', () => {
    expect(isAloneOnLine(line, 12, 40)).toBe(false);
  });
});

describe('overlapsSelection', () => {
  test('a cursor strictly inside overlaps', () => {
    expect(overlapsSelection([{ from: 5, to: 5 }], 0, 10)).toBe(true);
  });

  test('a cursor on either edge counts as inside', () => {
    expect(overlapsSelection([{ from: 0, to: 0 }], 0, 10)).toBe(true);
    expect(overlapsSelection([{ from: 10, to: 10 }], 0, 10)).toBe(true);
  });

  test('a cursor clear of the range does not overlap', () => {
    expect(overlapsSelection([{ from: 11, to: 11 }], 0, 10)).toBe(false);
    expect(overlapsSelection([], 0, 10)).toBe(false);
  });
});

describe('embedSizeCss', () => {
  test('a width alone leaves the height to the stylesheet', () => {
    expect(embedSizeCss(300, null)).toEqual({ width: '300px', height: null });
  });

  test('both dimensions become CSS lengths', () => {
    expect(embedSizeCss(300, 200)).toEqual({ width: '300px', height: '200px' });
  });

  test('no explicit size is no CSS at all', () => {
    expect(embedSizeCss(null, null)).toEqual({ width: null, height: null });
    expect(embedSizeCss(null, 200)).toEqual({ width: null, height: null });
  });

  test('a non-positive size is not a size', () => {
    expect(embedSizeCss(0, 0)).toEqual({ width: null, height: null });
    expect(embedSizeCss(300, 0)).toEqual({ width: '300px', height: null });
  });
});

describe('embedWidgetKey', () => {
  const base = {
    src: 'asset://a.png',
    alt: 'a.png',
    width: null as number | null,
    height: null as number | null,
    placement: 'block' as const,
    render: 'image' as const,
  };

  test('an unrelated edit (same everything) reuses the widget', () => {
    expect(embedWidgetKey(base)).toBe(embedWidgetKey({ ...base }));
  });

  test('resizing 300 -> 400 changes the key', () => {
    expect(embedWidgetKey({ ...base, width: 300 })).not.toBe(
      embedWidgetKey({ ...base, width: 400 }),
    );
  });

  test('a height change alone changes the key', () => {
    expect(embedWidgetKey({ ...base, width: 300, height: 200 })).not.toBe(
      embedWidgetKey({ ...base, width: 300, height: 100 }),
    );
  });

  test('src, alt, placement and render each change the key', () => {
    expect(embedWidgetKey({ ...base, src: 'asset://b.png' })).not.toBe(embedWidgetKey(base));
    expect(embedWidgetKey({ ...base, alt: 'other' })).not.toBe(embedWidgetKey(base));
    expect(embedWidgetKey({ ...base, placement: 'inline' })).not.toBe(embedWidgetKey(base));
    expect(embedWidgetKey({ ...base, render: 'error' })).not.toBe(embedWidgetKey(base));
  });
});

describe('planEmbeds — placement', () => {
  test('an Embed alone on its line is a block widget anchored at line.to', () => {
    const src = 'intro\n\n![a](a.png)\n\noutro';
    const doc = Text.of(src.split('\n'));
    const [plan] = planEmbeds([embedIn(src, '![a](a.png)')], doc, options());
    expect(plan.placement).toBe('block');
    expect(plan.at).toBe(doc.lineAt(src.indexOf('![a]')).to);
  });

  test('leading and trailing whitespace still counts as alone', () => {
    const src = '   ![a](a.png)   \n';
    const doc = Text.of(src.split('\n'));
    const [plan] = planEmbeds([embedIn(src, '![a](a.png)')], doc, options());
    expect(plan.placement).toBe('block');
  });

  test('an Embed among text is an inline widget anchored at the node end', () => {
    const src = 'see ![a](a.png) here';
    const doc = Text.of(src.split('\n'));
    const [plan] = planEmbeds([embedIn(src, '![a](a.png)')], doc, options());
    expect(plan.placement).toBe('inline');
    expect(plan.at).toBe(src.indexOf('![a](a.png)') + '![a](a.png)'.length);
  });
});

describe('planEmbeds — cursor overlap', () => {
  const src = 'see ![a](a.png) here\n\n![b](b.png)\n';
  const doc = Text.of(src.split('\n'));
  const inline = embedIn(src, '![a](a.png)');
  const block = embedIn(src, '![b](b.png)');

  test('an inline Embed is suppressed while its own line is active', () => {
    const plans = planEmbeds([inline, block], doc, options({ selection: [{ from: 2, to: 2 }] }));
    expect(plans.map((p) => p.placement)).toEqual(['block']);
  });

  test('a caret on another line leaves the inline Embed rendered', () => {
    const plans = planEmbeds(
      [inline, block],
      doc,
      options({ selection: [{ from: src.indexOf('![b]'), to: src.indexOf('![b]') }] }),
    );
    expect(plans.map((p) => p.placement)).toEqual(['inline', 'block']);
  });

  test('a block Embed is never suppressed, even with the caret on its line', () => {
    const at = src.indexOf('![b]') + 2;
    const plans = planEmbeds([block], doc, options({ selection: [{ from: at, to: at }] }));
    expect(plans).toHaveLength(1);
  });

  test('read mode never suppresses — there is no caret to reveal for', () => {
    const plans = planEmbeds(
      [inline, block],
      doc,
      options({ reading: true, selection: [{ from: 2, to: 2 }] }),
    );
    expect(plans.map((p) => p.placement)).toEqual(['inline', 'block']);
  });
});

describe('planEmbeds — render state', () => {
  const src = 'x ![a](a.png) y';
  const doc = Text.of([src]);

  test('a resolved local target becomes an image with a backend URL', () => {
    const [plan] = planEmbeds([embedIn(src, '![a](a.png)')], doc, options());
    expect(plan.render).toBe('image');
    expect(plan.src).toBe('asset://assets/a.png');
  });

  test('an unresolvable target becomes the error placeholder, not a dropped widget', () => {
    const [plan] = planEmbeds(
      [embedIn(src, '![a](a.png)', { target: 'missing.png', alt: 'missing.png' })],
      doc,
      options(),
    );
    expect(plan.render).toBe('error');
    expect(plan.src).toBe('');
  });

  test('a remote target becomes the click-to-load affordance and is never resolved', () => {
    let resolved = false;
    const [plan] = planEmbeds(
      [embedIn(src, '![a](a.png)', { target: 'https://example.com/x.png' })],
      doc,
      options({
        resolve: () => {
          resolved = true;
          return null;
        },
      }),
    );
    expect(plan.render).toBe('remote');
    expect(plan.src).toBe('https://example.com/x.png');
    expect(resolved).toBe(false);
  });

  test('a data: URI and any other scheme get no widget at all', () => {
    for (const target of ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'file:///tmp/a.png']) {
      expect(planEmbeds([embedIn(src, '![a](a.png)', { target })], doc, options())).toEqual([]);
    }
  });

  test('a non-image Attachment gets no widget (out of scope until af-3)', () => {
    expect(
      planEmbeds([embedIn(src, '![a](a.png)', { target: 'report.pdf' })], doc, options()),
    ).toEqual([]);
  });

  test('the name model and the path model each use their own resolver', () => {
    const seen: string[] = [];
    planEmbeds(
      [
        embedIn(src, '![a](a.png)', { kind: 'name', target: 'wide.png' }),
        embedIn(src, '![a](a.png)', { kind: 'path', target: './wide.png' }),
      ],
      doc,
      options({
        resolve: (e) => {
          seen.push(`${e.kind}:${e.target}`);
          return 'assets/wide.png';
        },
      }),
    );
    expect(seen).toEqual(['name:wide.png', 'path:./wide.png']);
  });

  test('an explicit size rides through to the plan', () => {
    const [plan] = planEmbeds(
      [embedIn(src, '![a](a.png)', { width: 300, height: 200 })],
      doc,
      options(),
    );
    expect([plan.width, plan.height]).toEqual([300, 200]);
  });
});

describe('planEmbeds — UTF-16 offsets', () => {
  // The bug the `scan_embeds_utf16` kernel variant exists to prevent: byte
  // offsets and JS string indices diverge after any non-ASCII character, and a
  // decoration built from the wrong unit lands past its Embed. The planner is
  // handed UTF-16 offsets, so its anchors must sit exactly on the construct.
  const prefix = 'Café \u{1F3A8} '; // 1 accented char + 1 surrogate pair
  const needle = '![a](a.png)';

  test('an inline anchor lands on the Embed end after non-ASCII text', () => {
    const src = `${prefix}see ${needle} here`;
    const doc = Text.of([src]);
    const [plan] = planEmbeds([embedIn(src, needle)], doc, options());
    expect(plan.placement).toBe('inline');
    expect(src.slice(plan.from, plan.to)).toBe(needle);
    expect(plan.at).toBe(plan.to);
  });

  test('a block anchor lands on the line end after non-ASCII text', () => {
    const src = `${prefix}\n\n${needle}\n\ntail`;
    const doc = Text.of(src.split('\n'));
    const [plan] = planEmbeds([embedIn(src, needle)], doc, options());
    expect(plan.placement).toBe('block');
    expect(src.slice(plan.from, plan.to)).toBe(needle);
    expect(plan.at).toBe(doc.lineAt(plan.from).to);
  });

  test('the byte offsets the default kernel reports would MISS the Embed', () => {
    const src = `${prefix}${needle}`;
    // What `scan_embeds` reports: the byte index of the `!`.
    const bytes = new TextEncoder().encode(prefix).length;
    expect(bytes).toBe(11);
    expect(src.indexOf(needle)).toBe(8);
    expect(src.slice(bytes, bytes + needle.length)).not.toBe(needle);
  });
});
