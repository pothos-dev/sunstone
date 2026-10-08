---
status: ready
priority: 1
---

# ov-16: Footnote render edge cases

**What to build:** close the gaps left after ov-14 between what the editor and the web viewer show for footnotes. The 2026-10-07 nightly review found these:

- A `[^1]` indented four spaces is an indented code block to comrak, but the shared scanner only skips fenced and inline code, so the native render puts `<sup>` markup inside `<pre><code>`.
- Two definitions of the same label (in any case) both emit `id="fn-<label>"`, so the HTML has duplicate ids.
- The fake backend's `renderTextWithFootnotes` works one line at a time and does not know about fences, so it renders `[^1]: x` inside a fenced block as a definition. The native render leaves it alone.
- A definition directly under a paragraph line (`Text.\n[^1]: note`) merges into that paragraph in the native render. The editor shows it on its own line.

- [ ] Only the first definition of a label (case-insensitive) carries `id="fn-…"`; later duplicates render the `[label]` row head without an id
- [ ] A definition line directly under a non-blank, non-definition line renders on its own line in the native render (leading `<br>`)
- [ ] The fake backend leaves `[^label]` inside a fenced block alone, the same as the native render
- [ ] The indented-code `[^1]` case is documented as a deviation in `docs/okf/linking.md`
- [ ] Rust render tests and `src/lib/ipc/fake/render.test.ts` cases for each; all four gates green

## Grounding

- Detection is `scan_footnotes` in `crates/sunstone-shared/src/footnotes.rs`. It shields fenced blocks and inline code through `scan::walk_code`, the code-aware contract shared by wikilinks, citations, anchor rewrite and move/rename (`crates/sunstone-shared/src/scan.rs` module doc). None of those consumers treat a four-space indented code block as code. The footnote test `definition_needs_line_start_and_colon` pins that `    [^1]: x` scans as a *reference*.
- Native HTML: `crates/sunstone-native/src/render/footnotes.rs` `footnotes_to_sentinels` turns each marker into a PUA sentinel before comrak runs, and `render/mod.rs:219` substitutes the HTML afterwards. A sentinel inside an indented code block is substituted as live markup inside `<pre><code>`. Labels are attribute-escaped, so this shows the wrong thing but is not an injection.
- Duplicate ids: `footnote_def_html` emits an id for every definition. The editor already jumps to the first one (`footnote_def_pos` uses `find`), so the HTML should match that.
- Paragraph merge: `footnotes_to_sentinels` adds `<br>` only when the previous line was itself a definition (`next_line_after_def`). A definition after ordinary text becomes a soft break inside the same `<p>`.
- Fake backend: `src/lib/ipc/fake/render.ts` renders line by line and has never tracked fences for any construct. `definedFootnotes` is collected from a whole-body `scanFootnotes(body)` (fence-aware), but `renderTextWithFootnotes` re-scans each line on its own.
- Anchors were lowercased on 2026-10-07 (nightly commit "lowercase the fn- anchor"), so duplicates across case collide on the same id.

## Decisions

- Indented code blocks → (c): no code change; record it as a documented deviation in `docs/okf/linking.md`. Indented code is rare in OKF bundles; teaching `scan::walk_code` about it is a cross-cutting change for its own ticket if anyone hits it. (Daniel, 2026-10-08)
- Duplicate definitions → the first one owns the anchor, matching the editor's `footnote_def_pos`. Later ones still show their row head.
- Definition after a paragraph line → reuse the existing `<br>` mechanism: emit it whenever the previous line is non-blank, not only after another definition.
- Fake fences → derive per-line markers from the single whole-body `scanFootnotes` result (offsets mapped to lines) instead of re-scanning each line. No general fence support for the fake; out of scope.

## Comments

- 2026-10-07: Footnotes now number by first use and resolve against `sources[].id` (see ov-10 comment). In the fake backend `definedFootnotes` became `footnotesByLabel` (the whole-body `scanFootnotes` result by lowercase label), which is the per-label half of the "derive from the whole-body scan" decision above.
