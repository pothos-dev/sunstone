// Unit tests for the fake backend's wikilink-aware outbound-link extraction and
// rename-rewrite. Run with `bun test src/lib`. These mirror the Rust backend's
// §1–§4 behaviour (see docs/adr/0004 + the wikilink spec) so backlinks and
// auto-rewrite work identically under Chromium/Playwright.
//
// `planRewrites` runs the SHARED Rust move/rename engine through the real wasm
// (`planMoveRewrites`, preloaded by bunfig.toml) — these tests pin the fake's
// seam over it (corpus in, writes keyed by post-move path out); the algorithm's
// goldens live in `crates/sunstone-shared/src/rewrite/moves.rs`.
//
// `outboundLinks` resolves wikilinks against the LIVE fixture (`conceptPaths()`),
// so the bare names below (`codemirror`, `bundle`, …) match the seeded fixture.
// The rewrite tests mutate `FILES` and restore it afterwards.
import { afterEach, describe, expect, test } from 'bun:test';
import { outboundLinks, planRewrites } from './links';
import { FILES } from './store';

const concept = (body: string) => `---\ntype: concept\ntitle: T\n---\n\n${body}\n`;

describe('outboundLinks — wikilinks', () => {
  test('a wikilink resolves by name and feeds backlinks', () => {
    const out = outboundLinks('concepts/links-demo.md', concept('See [[codemirror]].'));
    expect(out).toContain('concepts/codemirror.md');
  });

  test('alias + anchor are stripped before resolution', () => {
    const out = outboundLinks('index.md', concept('[[codemirror#usage|the editor]]'));
    expect(out).toContain('concepts/codemirror.md');
  });

  test('partial-path wikilink resolves by suffix', () => {
    const out = outboundLinks('index.md', concept('[[editor/live-preview]]'));
    expect(out).toContain('concepts/editor/live-preview.md');
  });

  test('unresolved wikilink contributes no edge', () => {
    const out = outboundLinks('index.md', concept('[[no-such-concept]]'));
    expect(out).not.toContain(undefined as unknown as string);
    expect(out.length).toBe(0);
  });

  test('self-target ([[#heading]]) does not create a self-edge', () => {
    const out = outboundLinks('concepts/codemirror.md', concept('Jump to [[#usage]].'));
    expect(out).not.toContain('concepts/codemirror.md');
  });

  test('wikilinks inside code fences / inline code are skipped', () => {
    const body = ['`[[codemirror]]`', '', '```', '[[bundle]]', '```'].join('\n');
    const out = outboundLinks('index.md', concept(body));
    expect(out).not.toContain('concepts/codemirror.md');
    expect(out).not.toContain('concepts/bundle.md');
  });

  test('embeds ![[ … ]] are not links — an Embed is no Backlinks edge', () => {
    const out = outboundLinks('index.md', concept('![[codemirror]]'));
    expect(out).not.toContain('concepts/codemirror.md');
  });

  test('a markdown Embed of a Concept path still creates no edge', () => {
    // The extraction half of the deliberate af-1 asymmetry: even when the Embed
    // target IS a Concept, `!` drops it. The plain link beside it still counts.
    const out = outboundLinks(
      'index.md',
      concept('![x](/concepts/codemirror.md) and [real](/concepts/bundle.md)'),
    );
    expect(out).not.toContain('concepts/codemirror.md');
    expect(out).toContain('concepts/bundle.md');
  });
});

describe('outboundLinks — inline code spans (CommonMark, as the Rust scanner)', () => {
  const links = (body: string) => outboundLinks('index.md', concept(body));

  test('an unmatched backtick is literal and hides nothing after it', () => {
    const out = links('Press the ` key.\n\nSee [[codemirror]] and [[bundle]]');
    expect(out).toContain('concepts/codemirror.md');
    expect(out).toContain('concepts/bundle.md');
  });

  test('a double-backtick span may contain a single backtick', () => {
    expect(links('Use ``a`b`` here. [[codemirror]]')).toContain('concepts/codemirror.md');
  });

  test('only spaces/tabs make a line blank (a NBSP line does not end a span)', () => {
    // As Rust/CommonMark: `\u00a0` is not blank, so the span runs on and hides it.
    expect(links('`a\n\u00a0\n[[codemirror]]`')).not.toContain('concepts/codemirror.md');
    expect(links('`a\n \t\n[[codemirror]]`')).toContain('concepts/codemirror.md');
  });

  test('a fence may be indented by spaces/tabs only', () => {
    // A `\r`-led line is not a fence, so the wikilink after it stays visible.
    expect(links('\r```\n[[codemirror]]')).toContain('concepts/codemirror.md');
  });

  test('a span may cross a single line break', () => {
    const out = links('`code\n[[codemirror]]` [[bundle]]');
    expect(out).not.toContain('concepts/codemirror.md');
    expect(out).toContain('concepts/bundle.md');
  });

  test('a closer must have exactly the opener length', () => {
    const hidden = links('`a``[[codemirror]]` [[bundle]]');
    expect(hidden).not.toContain('concepts/codemirror.md');
    expect(hidden).toContain('concepts/bundle.md');
    // No later single-backtick run: the opener is literal.
    expect(links('` [[codemirror]] `` x')).toContain('concepts/codemirror.md');
  });

  test('a span never crosses a blank line or a fence', () => {
    expect(links('a ` b\n\n[[codemirror]] ` c')).toContain('concepts/codemirror.md');
    expect(links('a ` b\n```\n`\n```\n[[codemirror]]')).toContain('concepts/codemirror.md');
  });
});

describe('planRewrites — wikilinks', () => {
  // Snapshot/restore the live FILES so each test is isolated.
  let snapshot: Record<string, string>;
  const setFiles = (files: Record<string, string>) => {
    snapshot = { ...FILES };
    for (const k of Object.keys(FILES)) delete FILES[k];
    Object.assign(FILES, files);
  };
  afterEach(() => {
    if (snapshot) {
      for (const k of Object.keys(FILES)) delete FILES[k];
      Object.assign(FILES, snapshot);
      snapshot = undefined as unknown as Record<string, string>;
    }
  });

  test('bare wikilink is rewritten on a basename change', () => {
    setFiles({
      'old.md': concept('# Old'),
      'linker.md': concept('See [[old]] and [[old|the label]].'),
    });
    const { summary, writes } = planRewrites('old.md', 'new.md');
    expect(summary.filesChanged).toBe(1);
    expect(summary.linksChanged).toBe(2);
    const rewritten = writes.get('linker.md')!;
    expect(rewritten).toContain('[[new]]');
    expect(rewritten).toContain('[[new|the label]]'); // alias preserved
  });

  test('a pure folder move leaves bare wikilinks untouched', () => {
    setFiles({
      'a/target.md': concept('# Target'),
      'linker.md': concept('See [[target]].'),
    });
    // Move the folder a/ -> b/: basename stays "target", so [[target]] is fine.
    const { summary, writes } = planRewrites('a', 'b');
    // The moved file itself has no outbound wikilinks; the linker is untouched.
    expect(writes.has('linker.md')).toBe(false);
    expect(summary.linksChanged).toBe(0);
  });

  test('partial-path wikilink is rewritten to a resolving suffix on move', () => {
    setFiles({
      'src/target.md': concept('# Target'),
      // A duplicate basename that sorts BEFORE the moved file's new folder, so a
      // bare `target` would resolve to it — forcing the rewrite to keep a path.
      'aaa/target.md': concept('# Other'),
      'linker.md': concept('See [[src/target#sec|label]].'),
    });
    const { writes } = planRewrites('src/target.md', 'zzz/target.md');
    const rewritten = writes.get('linker.md')!;
    // After the move, bare `target` resolves to aaa/target.md (alphabetical), so
    // the rewrite must keep the disambiguating folder + preserve anchor + alias.
    expect(rewritten).toContain('[[zzz/target#sec|label]]');
  });

  test('a bare rename never lands on another Concept of the new name', () => {
    setFiles({
      'a/x.md': concept('# X'),
      'y.md': concept('# Y'),
      's.md': concept('See [[x]].'),
    });
    const { writes } = planRewrites('a/x.md', 'a/y.md');
    // `[[y]]` would resolve to the root y.md; keep enough path to stay on a/y.md.
    expect(writes.get('s.md')).toContain('See [[a/y]].');
  });

  test('a bare name that still resolves is left byte-for-byte on a folder move', () => {
    setFiles({ 'old.md': concept('# Old'), 's.md': concept('[[Old]] [[old.md]]') });
    const { summary, writes } = planRewrites('old.md', 'f/old.md');
    expect(writes.has('s.md')).toBe(false);
    expect(summary.linksChanged).toBe(0);
  });
});

describe('planRewrites — Embeds (the af-1 `!`-asymmetry)', () => {
  // Same snapshot/restore harness as above: these tests drive the LIVE FILES.
  let snapshot: Record<string, string>;
  const setFiles = (files: Record<string, string>) => {
    snapshot = { ...FILES };
    for (const k of Object.keys(FILES)) delete FILES[k];
    Object.assign(FILES, files);
  };
  afterEach(() => {
    if (snapshot) {
      for (const k of Object.keys(FILES)) delete FILES[k];
      Object.assign(FILES, snapshot);
      snapshot = undefined as unknown as Record<string, string>;
    }
  });

  test("a moved Concept's relative Embed path is rewritten", () => {
    // THE case the asymmetry exists for: the Attachment did not move, the
    // Concept did, so the relative path must be recomputed or the image 404s.
    setFiles({ 'x.md': concept('![dot](./assets/dot.png)') });
    const { summary, writes } = planRewrites('x.md', 'sub/x.md');
    expect(writes.get('sub/x.md')).toContain('![dot](../assets/dot.png)');
    expect(summary.linksChanged).toBe(1);
  });

  test('the `!` and the alt text survive the rewrite verbatim', () => {
    // The alt text may carry a SIZE (`![300x200]`), so losing it would resize
    // the image; losing the `!` would turn the Embed into a link.
    setFiles({ 'x.md': concept('![300x200](./assets/wide.png) tail') });
    const { writes } = planRewrites('x.md', 'sub/x.md');
    expect(writes.get('sub/x.md')).toContain('![300x200](../assets/wide.png) tail');
  });

  test('a bundle-absolute Embed is left alone', () => {
    setFiles({ 'x.md': concept('![dot](/assets/dot.png)') });
    const { summary, writes } = planRewrites('x.md', 'sub/x.md');
    expect(writes.has('sub/x.md')).toBe(false);
    expect(summary.linksChanged).toBe(0);
  });

  test('![[name.png]] is untouched while ![a](./name.png) is rewritten', () => {
    // A NAME-resolved Embed resolves bundle-wide by name and suffix, so a move
    // can never invalidate it — the wikilink scanner must keep skipping embeds.
    setFiles({ 'x.md': concept('![[dot.png]] and ![a](./dot.png)') });
    const { summary, writes } = planRewrites('x.md', 'sub/x.md');
    const rewritten = writes.get('sub/x.md')!;
    expect(rewritten).toContain('![[dot.png]]');
    expect(rewritten).toContain('![a](../dot.png)');
    expect(summary.linksChanged).toBe(1);
  });

  test('an Embed of a moved Concept is rewritten too', () => {
    setFiles({ 'b.md': concept('# B'), 'a.md': concept('![img](/b.md)') });
    const { summary, writes } = planRewrites('b.md', 'folder/b.md');
    expect(writes.get('a.md')).toContain('![img](/folder/b.md)');
    expect(summary.linksChanged).toBe(1);
  });
});

describe('planRewrites — markdown links (through the shared wasm engine)', () => {
  let snapshot: Record<string, string>;
  const setFiles = (files: Record<string, string>) => {
    snapshot = { ...FILES };
    for (const k of Object.keys(FILES)) delete FILES[k];
    Object.assign(FILES, files);
  };
  afterEach(() => {
    if (snapshot) {
      for (const k of Object.keys(FILES)) delete FILES[k];
      Object.assign(FILES, snapshot);
      snapshot = undefined as unknown as Record<string, string>;
    }
  });

  test('an inbound absolute link follows its target; anchor/query/title survive', () => {
    setFiles({ 'b.md': concept('# B'), 'a.md': concept('[B](/b.md#sec?x=1 "T") [k](/keep.md)') });
    const { summary, writes } = planRewrites('b.md', 'folder/b.md');
    expect(writes.get('a.md')).toContain('[B](/folder/b.md#sec?x=1 "T") [k](/keep.md)');
    expect(summary).toEqual({ linksChanged: 1, filesChanged: 1 });
  });

  test('an inbound relative link is recomputed from the linker’s own folder', () => {
    setFiles({ 'b.md': concept('# B'), 'sub/c.md': concept('[B](../b.md)') });
    const { writes } = planRewrites('b.md', 'folder/b.md');
    expect(writes.get('sub/c.md')).toContain('[B](../folder/b.md)');
  });

  test("a moved Concept's own relative links are recomputed; absolute ones are not", () => {
    setFiles({ 'd.md': concept('# D'), 'b.md': concept('[D](./d.md) [E](/d.md)') });
    const { summary, writes } = planRewrites('b.md', 'folder/b.md');
    // Keyed by the POST-move path: the caller writes it after the rename.
    expect(writes.get('folder/b.md')).toContain('[D](../d.md) [E](/d.md)');
    expect(summary.linksChanged).toBe(1);
  });

  test('a folder move leaves links between co-moved siblings untouched', () => {
    setFiles({ 'f/x.md': concept('[Y](./y.md)'), 'f/y.md': concept('# Y') });
    const { summary, writes } = planRewrites('f', 'dest');
    expect(writes.size).toBe(0);
    expect(summary.linksChanged).toBe(0);
  });

  test('a markdown link inside a fenced code block is not rewritten', () => {
    // Native truth: the shared scanner copies fenced code verbatim.
    setFiles({ 'b.md': concept('# B'), 'a.md': concept('```\n[x](/b.md)\n```\n[y](/b.md)') });
    const { writes } = planRewrites('b.md', 'folder/b.md');
    expect(writes.get('a.md')).toContain('```\n[x](/b.md)\n```\n[y](/folder/b.md)');
  });

  test('a wikilink keeps its alias/anchor tail byte-for-byte', () => {
    setFiles({ 'old.md': concept('# Old'), 'a.md': concept('[[old|x#y]]') });
    const { writes } = planRewrites('old.md', 'new.md');
    expect(writes.get('a.md')).toContain('[[new|x#y]]');
  });

  test('renaming a Concept that is not in the corpus plans nothing', () => {
    setFiles({ 'a.md': concept('[[nope]]') });
    const { summary, writes } = planRewrites('nope.md', 'z/nope.md');
    expect(writes.size).toBe(0);
    expect(summary).toEqual({ linksChanged: 0, filesChanged: 0 });
  });
});
