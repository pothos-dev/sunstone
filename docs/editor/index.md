# Editor — CodeMirror integration

How Sunstone's markdown editor is built on CodeMirror 6. Start with the integration overview, then the dependency, its patch, and Sunstone's own extensions.

## Concepts

- [CodeMirror integration](codemirror.md) - How `cm.ts` assembles the `EditorView`, and switches modes/themes/Concepts without a rebuild.
- [atomic-editor](atomic-editor.md) - The `@atomic-editor/editor` dependency that supplies the live-preview decoration layer, and which of its extensions Sunstone consumes.
- [The vendored atomic-editor patch](atomic-editor-patch.md) - The local patch to `@atomic-editor/editor@0.4.3` and why each change exists.
- [Sunstone's own CodeMirror extensions](custom-extensions.md) - Diagrams (mermaid, D2, PlantUML), wikilinks, broken links, citations, CriticMarkup, anchor tracking, frontmatter, find and formatting.

## Related

- [Editor layout](/editor/editor-layout.md) - The tiling model that hosts these editor views.
- [ADR-0001](/adr/0001-codemirror-hybrid-live-preview.md), [ADR-0004](/adr/0004-wikilinks-optional-secondary-name-based.md), [ADR-0005](/adr/0005-mermaid-block-rendering.md) - The decisions behind the integration.
