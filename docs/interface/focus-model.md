---
type: Concept
title: Focus model — Regions and the Focused item
description: How keyboard focus works in Sunstone — the six-Region grid, directional movement, and the item focused within a Region.
tags: [focus, keyboard, region, navigation]
timestamp: 2026-07-22
---

# Focus model

Sunstone has two nested layers of keyboard focus: the **active Region** (which
surface owns the keyboard) and the **Focused item** (which element inside that
surface the keys act on). Both are defined in the [glossary](/GLOSSARY.md); this
page is the mechanics.

## Regions and the 3×2 grid

A **Region** is an interactive surface that can hold keyboard focus and defines
its own keyboard semantics. Regions are orthogonal to Pane/Section: a Region may
*be* a Pane (the **Editor** — see [editor layout](/editor/editor-layout.md)), live *as* a
Section (**Explorer**, **Tags**, **Outline**, **Backlinks**), or be neither
(**Frontmatter**, which is chrome inside the Editor pane).

The six Regions form a **fixed 3×2 grid**:

|        | col 0 (left) | col 1 (editor) | col 2 (right) |
| ------ | ------------ | -------------- | ------------- |
| row 0  | Explorer     | Frontmatter    | Outline       |
| row 1  | Tags         | Editor         | Backlinks     |

Exactly one Region is active at a time. **DOM focus is the single source of
truth**: the active Region is a rune that *mirrors* `document.activeElement` via
`focusin`/`focusout`; it never drives focus, only reflects it, so the UI can
reactively style the active Region.

## Directional movement

`Alt`+arrows / `Alt`+`hjkl` move the active Region across the grid. Movement:

- **skips absent Regions** and **clamps at grid edges** (no wrap);
- **sticky per-column landing** — moving left/right returns to the Region you
  were last in for the destination column.

Two predicates split "can I go here?":

- **`isPresent()`** — is there content to focus? False for genuinely empty
  Regions (Frontmatter with no open Concept, Tags with no tags). These are
  skipped and never revealed.
- **`isVisible()`** — is the Region shown right now? A Region hidden only by a
  collapse is *present but not visible*; moving into it **reveals** it (flips the
  transient flag) and then focuses it once rendered.

## The Focused item

Within a Region, the **Focused item** is the single navigable element holding
focus — the roving-`tabindex` element. Arrow keys move it; Enter activates it.

The sharp edge is in the **Explorer**: the Focused item (a tree row, the
keyboard cursor) is **distinct from the open Concept**. Arrowing moves the
Focused item without opening anything; Enter opens the Focused Concept into the
Editor. The open Concept keeps its own marker; the Focused item shows a separate
focus ring. They coincide only until you arrow away.

### Focus depths in Frontmatter

The **Frontmatter** Region hosts a small YAML editor (see
[ADR 0008](/adr/0008-raw-yaml-frontmatter-editing.md) for why frontmatter is
edited as text, in its own editor rather than in the document). It has **two
depths**, so Escape peels exactly one layer per press like everywhere else:

- **Region** — the Region container holds focus; `Enter` drops into the YAML.
- **Editing** — the YAML editor holds focus and owns the keyboard; `Escape`
  returns to the container, and a second `Escape` homes to the Editor.

Alt-in from the Editor lands directly in the YAML (the Region's entry point).
Undo and redo are forwarded to the **body** editor's history, so one timeline
spans both surfaces; a step that changes the frontmatter moves focus back here,
expanding the Region if it was collapsed.

## Relationships

- Each **Region** has at most one **Focused item**.
- The **Editor** Region *is* a Pane and hosts its own inner structure — see
  [editor layout](/editor/editor-layout.md).
- The Explorer/Tags/Outline/Backlinks Regions live inside the two
  [Sidebars](/interface/sidebars.md); moving focus into a collapsed one
  **reveals** it (the transient-reveal flags described there).
- The Region grid sits inside the [app shell](/interface/app-shell.md).
- Terms are indexed in the [glossary](/GLOSSARY.md).
