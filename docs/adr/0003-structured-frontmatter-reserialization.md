# Structured frontmatter model with whole-block re-serialization

> **Status: Superseded by [ADR-0008](0008-raw-yaml-frontmatter-editing.md).**
> The `Property[]` model, the Properties panel over it, and whole-block re-serialization are
> removed — frontmatter is edited as YAML text instead, so it round-trips byte-for-byte and the
> nested OKF v0.2 families become authorable. The unified-undo mechanism described below survives,
> with the effect payload changed from `Property[]` to a YAML string.

**Supersedes:** [ADR-0002](0002-flat-frontmatter-model.md)

Frontmatter is now held as **structured `Property[]` state in a CodeMirror `StateField`** — the
single source of truth while a Concept is open — and the YAML block is **stripped from the
markdown editor entirely** (the CodeMirror document holds only the body). On every change we
**re-serialize the whole frontmatter block** from the `Property[]` and recombine it with the body
to produce the on-disk markdown (`serialize(props)` + body).

This replaces ADR-0002's byte-range splicing round-trip. ADR-0002 kept the YAML in the document
and edited a single value in place, preserving every other byte — comments, quoting style,
formatting — verbatim. **That verbatim guarantee is intentionally dropped here.** Editing any field
now rewrites the entire block from structured form.

## Why drop verbatim preservation

The flat in-place model could only edit values that already existed. The behaviours we want —
**adding** new properties, **deleting** them, and **renaming** keys — all change the shape of the
map, not just a value, and a structured `Property[]` with whole-block serialization expresses them
directly. Keeping frontmatter as structured state in a `StateField` also lets frontmatter edits ride
CodeMirror's transaction/history machinery, which is what makes a **unified body + frontmatter undo
timeline** possible (frontmatter changes become `setFrontmatter` effects recorded via
`invertedEffects`). Preserving incidental YAML formatting is not worth forgoing those capabilities for
a lightweight quick-editing editor.

## How OKF conformance is preserved

Re-serializing the whole block still satisfies OKF v0.1 (see [okf-spec.md](../okf/spec.md), §4.1 and
§9):

- **Required `type`.** The serializer always emits the `type` key when present. (The Properties panel
  originally surfaced a required-`type` warning when it was missing or empty; that warning was later
  removed so files in directories that don't follow OKF aren't nagged toward conformance.)
- **Unknown keys preserved.** Producer-defined keys we don't model specially are classified as
  `complex` and carry their original source text in `raw`; on serialization they are re-emitted
  faithfully from `raw`, so unknown keys, nested maps, multi-line/block scalars, and the like are
  round-tripped rather than dropped or mangled. This honours §9's "consumers SHOULD preserve unknown
  keys when round-tripping."

What is *not* preserved is purely cosmetic: comments, quoting choices, and whitespace of fields we
re-emit from structured form. OKF does not require those.

## Consequences

- A field's quoting/formatting may normalise after the first edit (e.g. `'note'` → `note`). This is
  expected, not a bug.
- Comments inside the frontmatter block are not retained once the block is re-serialized.
- Reserved files (`index.md`, `log.md`) carry no frontmatter and show no Properties panel, so this
  model does not apply to them.
- `complex`/unknown values remain read-only in the panel but are guaranteed to survive edits to other
  fields via their stored `raw` text — this round-trip path must stay covered by tests.
