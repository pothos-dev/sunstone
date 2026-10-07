---
status: done
---

# ov-14: Footnote detection and rendering in the body

**What to build:** a `[^label]` footnote reference in a Concept body renders as a clickable superscript in the editor (hybrid + reading) and in the web viewer, and a click jumps to its `[^label]: …` definition, the same way an `[n]` citation jumps to its table row today. This is the body-syntax half of [ov-10](ov-10-sources-provenance-family.md), split out so it can ship before the `sources` Frontmatter family (which waits on ov-3 / ov-4). Nothing here reads or joins to `sources`.

- [x] A shared Rust scanner in `sunstone-shared` finds footnote references and definitions (UTF-16 offsets, code-aware); the editor calls it through wasm, the native render calls it directly (ADR 0006, no TS twin)
- [x] An inline `[^label]` renders as a superscript showing the label as written (`[^2]` → `[2]`); clicking it scrolls to the definition and flashes the line
- [x] A line-start `[^label]:` definition renders as a styled `[label]` row head; in hybrid mode the raw marker shows when the cursor is on it
- [x] A reference with no matching definition renders with broken-link styling and does nothing on click
- [x] `[^label]` inside inline code or a fenced block is left untouched
- [x] The web viewer (native render + fake backend) emits the same markup, with the definition as the jump target
- [x] The `[n]` citation form keeps working unchanged
- [x] Docs (`docs/okf/linking.md`, `docs/editor/custom-extensions.md`) describe the footnote form
- [x] Rust unit tests for the scanner and render; a desktop Playwright spec for the editor behaviour
- [x] All four gates green

## Decisions

- Scope → body detection and rendering only. `sources`, `id` joining and credibility signals stay in ov-10.
- Labels render as written, not renumbered. Today's sources use numeric labels (`[^2]`); mapping string ids to consecutive numbers belongs to the `sources` work. **Superseded** after real Bundles turned up string ids: numbering by first use and resolving labels against `sources[].id` were pulled forward from ov-10 (see the comment in ov-10).
- Click → jump to the definition and flash it, same as `[n]` today. No hover popup.
- Web rendering → the existing sentinel pass, not comrak's `extension.footnotes`. comrak renumbers footnotes by first use and moves the definitions into an end-of-document section, which contradicts "render as written" and would make the web view disagree with the editor. Using the shared scanner keeps one recognition for both shells. ov-10's comrak plan should be revisited when it is picked up.
- Undefined reference → broken-link styling, so typos show.
- Migration of existing `[n]` documents → a script in the `/llm-wiki` skill, not a Sunstone feature.
