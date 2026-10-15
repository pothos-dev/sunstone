---
status: done
priority: 1
---

# ov-23: Sources back-ref ids drift from the refs the body renders

**What to build:** each Sources entry's back-refs (`#fnref-<label>-<k>`) point
at ids that exist in the rendered body, on the native and fake renders.

Found in the 2026-10-09 nightly review:

- A ref on the line of a hidden source definition (`[^s]: see also[^t]`) is
  dropped from the native body (the 2026-10-09 panic fix), but `source_list`
  still counts it in `refs`, so `t`'s entry links one more back-ref than the
  body has.
- Fake render (`src/lib/ipc/fake/render.ts`): a `[^s]` inside a CriticMarkup
  mark, or in a heading where `line.indexOf(h.text)` fails, gets no `fnref` id
  but is still counted. For `a {++b[^s]++} c[^s]` the entry links `fnref-s-1`
  and `fnref-s-2`, while `c` carries `fnref-s-1`.
- The fake's `sourceLinkAttrs` writes a `resource` straight into `href`; the
  native render now drops `javascript:`/`data:`/`vbscript:`/`file:` there.

- [x] `sources::source_list` leaves out of `refs` every reference on a hidden source-definition line (a definition whose label is a `sources[].id`, to the end of that line), the same span `footnotes_to_sentinels` drops; the fake gets this through wasm `sourceList`
- [x] The fake renders a footnote inside a CriticMarkup mark the way the native render does (as a reference, with its `fnref` id), so every ref `source_list` counts carries an id
- [x] The fake's heading path never drops a line's footnotes: heading refs are located without the `indexOf` fallback that returns `[]`
- [x] The script-URL check (`is_script_url`) moves into `sunstone-shared` and is exported through wasm; the fake's `sourceLinkAttrs` gives such a resource no `href`, in the reference and the Sources entry, as the native render does
- [x] Tests: a `sources.rs` golden (`[^s]: see also[^t]` with `t` a source: `t.refs` has only the body refs); a native `render/footnotes.rs` case asserting every `#fnref-…` back-ref href has a matching `id=` in the HTML; `src/lib/ipc/fake/render.test.ts` cases for the mark example above, a heading ref and a `javascript:` resource
- [x] All four gates green, after `bun run build:wasm`

## Grounding

- `crates/sunstone-shared/src/sources.rs:153` `source_list` walks
  `scan_footnotes(body, ids)` and pushes `f.from` into `refs` for every
  non-definition match of a source id. It has no idea of hidden lines.
- Native: `crates/sunstone-native/src/render/footnotes.rs`
  `footnotes_to_sentinels` skips to the end of a source definition's line
  (`f.def && source.is_some()`), and `if f.from < pos { continue }` drops any
  ref on it. Its `cited` counter numbers only the refs it emits, while
  `backrefs_html` emits `1..=s.refs.len()`. The existing test
  `a_hidden_source_definition_with_a_ref_on_its_line_does_not_panic` uses a
  plain footnote `t`, so it does not catch the drift; make `t` a source.
- Native marks: `render/mod.rs` runs `critic_to_sentinels` (line ~158, swaps
  only the delimiters) before `footnotes_to_sentinels` (line ~175), so a ref
  inside `{++…++}` renders as a reference with its id. The fake's
  `renderInline` escapes a mark's text whole, and `render.test.ts:227`
  ("a footnote inside a CriticMarkup mark stays text") pins that divergence;
  that test changes.
- Fake headings: `OutlineHeading.text` (`crates/sunstone-shared/src/outline.rs`
  `atx_heading`) is a verbatim slice of the line (trimmed, closing `#`s
  dropped), so `line.indexOf(h.text)` finds it in every case tried while
  grounding. The `at < 0 ? []` branch is the risk, not a reproduced bug: it
  silently drops refs. Replace the search with the text's known offset (the
  hashes plus whitespace before it) or render the whole line's footnotes.
- Script URLs: `crates/sunstone-native/src/render/mod.rs:368` `is_script_url`
  (scheme `javascript` / `vbscript` / `data` / `file`, case-insensitive), used
  by `link_attrs`. Native-only today, so the fake has no shared way to ask.
  `docs/okf/linking.md` already documents the rule (50baa70).
- Numbering: a ref on a hidden line still takes a footnote number in
  `scan_footnotes`. That is the shared scanner the editor also uses, where the
  line is visible. Not changed here.

## Decisions

- Where to fix the hidden-line drift → `source_list` (shared), not the render.
  Native and fake both read `refs` from it, so one change fixes both.
- Refs inside marks in the fake → render them as native does, rather than
  stop counting them. The fake mirrors native markup; the native is right
  (a claim inside an insertion still cites its source).
- Numbering of a ref that only appears on a hidden line → unchanged. It is a
  scanner question shared with the editor, outside the back-ref bug; a separate
  ticket if anyone notices it.
- Script URLs → shared predicate over wasm (ADR 0006), not a TS regex in the
  fake.

## Comments

- 2026-10-15 (nightly): Done. Beyond the ticket, `source_list` also leaves out a
  ref inside a CriticMarkup comment: the native render turns the comment into
  plain text (`critic_to_sentinels`), so such a ref never got an id either. As
  decided, `num` is unchanged: an entry still takes the scanner's number even
  when its only ref is on a hidden line or in a comment. `is_script_url` now
  reads the scheme the way a browser does (it skips leading controls and
  ignores tabs and newlines), because the fake writes the raw resource into
  `href`. The fake's heading path takes the text offset as the hashes plus the
  whitespace after them.
