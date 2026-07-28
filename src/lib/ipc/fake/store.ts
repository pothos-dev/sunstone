// Shared in-memory state + fixture data for the fake backend.
//
// `FILES` / `FOLDERS` are MUTABLE module-level state that every other fake
// module reads and mutates. They are exported as live bindings: because ES
// modules share a single instance per specifier, importing `FILES` here and in
// the tree/link-rewrite modules all refer to the SAME object — there is never a
// second copy. Functions mutate them in place (e.g. `FILES[path] = ...`,
// `FOLDERS.add(...)`); they are never reassigned, so the bindings stay stable.

/** The fake bundle's absolute root path (mirrors a real opened Bundle path). */
export const FAKE_BUNDLE_ROOT = '/fake/bundle';

/** Map of bundle-relative path -> raw markdown content. */
export const FILES: Record<string, string> = {
  'index.md': `---
type: index
title: Knowledge Base
description: Entry point for this demo Bundle.
tags: [okf, demo]
---

# Knowledge Base

Welcome. This is the reserved \`index.md\` for progressive disclosure.

## Contents

- [Concepts](/concepts/index.md)
- [Editor design](/concepts/editor/live-preview.md)
- [Change log](/log.md)
`,

  'log.md': `---
type: log
title: Change Log
---

# Log

- 2026-06-16 — Seeded the demo Bundle for the walking skeleton.
- 2026-06-15 — Initial Bundle created.
`,

  'concepts/index.md': `---
type: index
title: Concepts
tags: [okf]
---

# Concepts

- [CodeMirror](./codemirror.md)
- [Live preview](./editor/live-preview.md)
- [Bundle](./bundle.md)
`,

  'concepts/codemirror.md': `---
type: concept
title: CodeMirror
description: The editor core used by Sunstone.
tags: [editor, dependency]
timestamp: 2026-06-15T10:00:00Z
---

# CodeMirror

CodeMirror 6 is the editor core. Sunstone layers OKF-aware extensions on top.

The distinctive word marmalade appears here so full-text search has a target.

It powers the [Live preview](./editor/live-preview.md) experience.
`,

  'concepts/bundle.md': `---
type: concept
title: Bundle
description: The root folder opened by Sunstone.
tags: [okf, core]
---

# Bundle

A **Bundle** is the root folder opened by Sunstone — a tree of Concepts and
reserved files, per the OKF spec.

A second mention of Marmalade lives here to prove cross-Concept full-text search.

See also [CodeMirror](./codemirror.md) (relative link) and the
[Knowledge Base](/index.md) entry point (bundle-absolute link).
`,

  // A Concept exercising the frontmatter Properties panel: scalars, a `tags`
  // flat list, an EMPTY required `type` (flag case), an unknown/extra key, and
  // — critically — complex values (a nested map and a multi-line block scalar)
  // that must round-trip BYTE-FOR-BYTE when an unrelated scalar is edited.
  'concepts/complex-frontmatter.md': `---
type:
title: Complex Frontmatter
description: Exercises the Properties panel.
tags: [okf, complex]
custom_field: keep me intact
nested:
  author: jane
  reviewers:
    - bob
    - carol
prose: |
  This is a multi-line
  block scalar that must
  be preserved verbatim.
---

# Complex Frontmatter

This Concept has nested and multi-line frontmatter to prove verbatim
round-tripping when an unrelated scalar is edited.
`,

  // A Concept whose frontmatter contains DUPLICATE top-level keys (`title`
  // twice). The in-app key-commit path forbids creating duplicates, but a file
  // authored OUTSIDE the app can still reach this state — `parseProperties`
  // yields two separate rows with the same key. This fixture lets the Properties
  // panel's defensive row-id keying be exercised: editing the SECOND duplicate
  // row must update the second row, not the first matching key.
  'concepts/duplicate-keys.md': `---
type: concept
title: First Title
title: Second Title
tags: [dupdemo]
---

# Duplicate Keys

This Concept was authored outside the app and has two \`title\` keys.
`,

  // A Concept exercising the broken-link decoration AND the backlink graph:
  // it links to TWO existing Concepts (relative + bundle-absolute) and to TWO
  // non-existent targets (relative + bundle-absolute). Broken links must render
  // visually distinct yet stay clickable; existing links stay normal. This
  // Concept also gives `concepts/codemirror.md` and `index.md` extra backlinks,
  // making the backlinks query non-trivial.
  'concepts/links-demo.md': `---
type: concept
title: Links Demo
description: Exercises broken-link styling and the backlink graph.
tags: [okf, links]
---

# Links Demo

Working links resolve to real Concepts:

- [CodeMirror](./codemirror.md) — existing (relative)
- [Knowledge Base](/index.md) — existing (bundle-absolute)

Broken links point at Concepts that do not exist; they must render distinct
but stay clickable (never blocked, per the OKF spec):

- [Ghost Concept](./ghost.md) — broken (relative)
- [Missing Page](/does-not-exist.md) — broken (bundle-absolute)

An external link is never treated as broken: [Example](https://example.com).
`,

  // A Concept with NO frontmatter block at all. Exercises adding the first
  // property to a frontmatter-less doc (slice: add-property-text-or-list): the
  // serializer must synthesize a valid `---…---` block on the first commit.
  'concepts/no-frontmatter.md': `# No Frontmatter

This Concept has no YAML frontmatter block. Adding a property must synthesize
one from scratch.
`,

  // A Concept exercising the Outline Section (slice: outline-section): several
  // headings at varying levels (for indentation + scroll), a `#`-prefixed line
  // INSIDE the frontmatter (a YAML comment that must NOT become an H1), and a
  // `#`-prefixed line INSIDE a fenced code block (a shell comment that must NOT
  // become a heading). The Outline must list exactly the four real headings.
  // Trailing filler prose (appended AFTER the last heading, so every heading's
  // line number stays put) makes the body taller than the editor viewport, which
  // is what lets the active-heading spec scroll the last heading to the top.
  'concepts/outline-demo.md': `---
type: concept
title: Outline Demo
# this YAML comment must not appear in the outline
tags: [outline-demo]
---

# Outline Demo

Intro prose under the top-level heading.

## First Section

Some body text.

### A Subsection

A fenced code block whose comment must not be read as a heading:

\`\`\`sh
# this is a shell comment, not a heading
echo hello
\`\`\`

## Second Section

Closing prose.

${Array.from({ length: 60 }, (_, i) => `Trailing filler line ${i + 1} to make this Concept taller than the editor viewport, so the last heading can be scrolled to the top.`).join('\n\n')}
`,

  // A Concept whose body contains MANY lines sharing one distinctive word
  // (`pomegranate`), so a single full-text query returns far more hits than the
  // Search panel's capped result list can show at once. This is what lets the
  // search-scroll-into-view spec exercise keyboard navigation past the bottom of
  // the scroll viewport. Its tag (`searchdemo`) and type (`concept`) are chosen
  // so it does NOT perturb the exact tag/type counts other specs assert on.
  'concepts/search-overflow.md': `---
type: concept
title: Search Overflow
description: Many matching lines to overflow the search results list.
tags: [searchdemo]
---

# Search Overflow

The word pomegranate line 01 exists so full-text search returns many hits.
The word pomegranate line 02 exists so full-text search returns many hits.
The word pomegranate line 03 exists so full-text search returns many hits.
The word pomegranate line 04 exists so full-text search returns many hits.
The word pomegranate line 05 exists so full-text search returns many hits.
The word pomegranate line 06 exists so full-text search returns many hits.
The word pomegranate line 07 exists so full-text search returns many hits.
The word pomegranate line 08 exists so full-text search returns many hits.
The word pomegranate line 09 exists so full-text search returns many hits.
The word pomegranate line 10 exists so full-text search returns many hits.
The word pomegranate line 11 exists so full-text search returns many hits.
The word pomegranate line 12 exists so full-text search returns many hits.
The word pomegranate line 13 exists so full-text search returns many hits.
The word pomegranate line 14 exists so full-text search returns many hits.
The word pomegranate line 15 exists so full-text search returns many hits.
The word pomegranate line 16 exists so full-text search returns many hits.
The word pomegranate line 17 exists so full-text search returns many hits.
The word pomegranate line 18 exists so full-text search returns many hits.
The word pomegranate line 19 exists so full-text search returns many hits.
The word pomegranate line 20 exists so full-text search returns many hits.
The word pomegranate line 21 exists so full-text search returns many hits.
The word pomegranate line 22 exists so full-text search returns many hits.
The word pomegranate line 23 exists so full-text search returns many hits.
The word pomegranate line 24 exists so full-text search returns many hits.
The word pomegranate line 25 exists so full-text search returns many hits.
The word pomegranate line 26 exists so full-text search returns many hits.
The word pomegranate line 27 exists so full-text search returns many hits.
The word pomegranate line 28 exists so full-text search returns many hits.
The word pomegranate line 29 exists so full-text search returns many hits.
The word pomegranate line 30 exists so full-text search returns many hits.
`,

  // A Concept whose COMMITTED content already carries a real CriticMarkup
  // highlight+comment annotation. Drives the review-diff toggle's "pre-existing
  // annotations still render" case (issue 04): editing an UNRELATED line leaves
  // the annotated line unchanged between HEAD and the working tree, so the
  // review view renders the annotation as an ordinary highlight alongside the
  // diff marks (not nested inside a change span). No `tags` so it never perturbs
  // the tag counts other specs assert on.
  'concepts/annotated.md': `---
type: concept
title: Annotated
---

# Annotated

This line has a {==pre-existing==}{>>a standing note<<} annotation that
predates any review of the document.

An unrelated closing paragraph.
`,

  'concepts/editor/live-preview.md': `---
type: concept
title: Live Preview
description: Obsidian-style hybrid editing.
tags: [editor, codemirror]
---

# Live Preview

Obsidian-style hybrid editing: the markdown source is the source of truth, but
inactive lines render styled while the cursor line shows raw markup. Text can be
**bold**, *italic*, or \`inline code\`.

## Features

- [x] Inactive lines render styled
- [ ] Cursor line reveals raw markup
- Lazy-loaded fenced-code grammars

A fenced code block, syntax-highlighted via a lazy-loaded grammar:

\`\`\`ts
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

A GFM table renders as an interactive widget:

| Feature      | Status |
| ------------ | ------ |
| Headings     | done   |
| Code blocks  | done   |
| Tables       | done   |

Inline image (data URI — renders fully under the fake backend):

![green dot](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCI+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMjgiIGZpbGw9IiMyZWNjNzEiLz48L3N2Zz4=)

Local image (resolved relative to the Concept; the widget renders even if the
src 404s under the fake backend — there is no static file server here):

![diagram](./assets/diagram.png)

A mermaid fenced block renders as a Diagram (ADR-0005) under live preview /
reading; the cursor entering it reveals the raw fence:

\`\`\`mermaid
graph TD
  A[Source] --> B[Live preview]
  B --> C[Diagram]
\`\`\`

Built on [CodeMirror](../codemirror.md).

# Citations

- https://example.com/bare-autolink

[1] [BigQuery table schema](https://example.com/bq-schema)
`,
};

/**
 * Snapshot of the fixture at module load — the fake's stand-in for the git
 * COMMITTED (HEAD) state (git seam / review-diff). `FILES` is the mutable
 * WORKING TREE (autosave + runtime `createConcept`/`simulateExternalChange`
 * mutate it); `COMMITTED_FILES` never changes, so `fileAtRev(path, 'HEAD')`
 * returns the original content and a review diff against the edited working tree
 * is stable. A path present in the working tree but ABSENT here was created
 * after the snapshot, so the fake reports it `untracked` — exactly as a real
 * repo reports a never-committed file. String values are immutable, so a shallow
 * copy is a faithful snapshot.
 */
export const COMMITTED_FILES: Record<string, string> = { ...FILES };

/**
 * Explicitly-created folders that contain no `.md` file yet. Folders are
 * normally inferred from file paths, but `createFolder` can make an empty one;
 * we track those here so the tree reflects them (like a real empty directory).
 */
export const FOLDERS = new Set<string>();

/** All `.md` Concept paths currently in the fixture, sorted. */
export function conceptPaths(): string[] {
  return Object.keys(FILES)
    .filter((p) => p.endsWith('.md'))
    .sort();
}

/** Reject paths that escape the bundle, mirroring the Rust validation. */
export function isSafePath(path: string): boolean {
  if (path.startsWith('/')) return false;
  return !path.split('/').includes('..');
}

/** True if `path` is an existing folder (explicit, or implied by a file). */
export function folderExists(path: string): boolean {
  if (FOLDERS.has(path)) return true;
  const prefix = `${path}/`;
  return Object.keys(FILES).some((p) => p.startsWith(prefix));
}

/** True if `path` is an existing file OR folder. */
export function pathExists(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(FILES, path) || folderExists(path);
}
