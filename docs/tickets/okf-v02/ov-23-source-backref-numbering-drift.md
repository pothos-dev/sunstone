---
status: captured
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
