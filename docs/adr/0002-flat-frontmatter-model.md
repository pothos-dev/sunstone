---
type: Decision
title: "Flat key/value frontmatter model"
description: "Frontmatter was edited as a flat, ordered key/value map, with anything complex kept as a read-only raw field."
status: deprecated
tags: [adr, decision]
---

# Flat key/value frontmatter model

> **Status: Superseded by [ADR-0003](0003-structured-frontmatter-reserialization.md).**
> The flat map is retained, but the in-place verbatim-splicing round-trip described below is
> replaced by holding frontmatter as structured `Property[]` and re-serializing the whole block.
> The verbatim-preservation rule no longer holds.

The frontmatter Properties editor treats frontmatter as a **flat, ordered map of key →
value**, deliberately *not* modeling YAML's full complexity. Scalar values are edited as plain
text inputs; flat lists (notably `tags`) are edited as chips. Any value we cannot represent
simply — nested maps, multi-line blocks, anything non-scalar/non-flat-list — is **preserved
verbatim as a read-only raw field** and round-tripped untouched.

This is a deliberate simplification: most OKF frontmatter is simple key/value, and a friendly
flat editor beats a full YAML form for the lightweight, quick-editing feel we want. The
verbatim-preservation rule is what keeps us conformant with the OKF requirement that consumers
"preserve unknown keys" and never reject or corrupt a document.

## Consequences

- A future reader might expect a full YAML editor and try to "fix" the flat model — this is
  intentional, not a limitation to remove.
- Reserved files (`index.md`, `log.md`) are exempt from the required-`type` check but otherwise
  use this same model when they do carry frontmatter (e.g. `tags` on an `index.md`).
