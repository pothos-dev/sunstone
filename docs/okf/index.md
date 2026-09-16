# OKF — Open Knowledge Format in Sunstone

The format Sunstone reads and writes, plus how Sunstone's handling of it differs from the pure spec.

## Concepts

- [Open Knowledge Format (OKF) Specification](spec.md) - Vendored, verbatim copy of the upstream OKF v0.2 spec.
- [Concept](concept.md) - What OKF says a Concept is, and how Sunstone models its frontmatter and body.
- [Bundle](bundle.md) - What OKF says a Bundle is, and how Sunstone opens, roots, indexes, and commits one.
- [Linking](linking.md) - The link model (markdown + wikilink, anchors, citations, backlinks, rewrite) over a Bundle.

## Related

- [Glossary](/GLOSSARY.md) - The **Bundle**, **Concept**, **Reserved file**, and **Frontmatter** terms.
- [ADR-0002](/adr/0002-flat-frontmatter-model.md), [ADR-0003](/adr/0003-structured-frontmatter-reserialization.md), [ADR-0004](/adr/0004-wikilinks-optional-secondary-name-based.md), [ADR-0005](/adr/0005-mermaid-block-rendering.md) - The decisions behind Sunstone's OKF handling.
