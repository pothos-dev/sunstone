---
status: done
blocked-by: [ov-12]
---

# ov-13: The `# Computation` conventional body heading

**What to build:** the code in an `Attested Computation` is presented as the computation it is, rather than as an anonymous fenced block partway down the page. OKF v0.2 adds `# Computation` to its set of conventional body headings — the section holding the query or model the Concept attests to, alongside the prose that cites its sources.

This is the smallest change in v0.2 and deliberately last: it is presentation over a Concept type that must already parse. The heading is conventional, not required, so a Concept using it gains the affordance and one that does not loses nothing.

- [x] A `# Computation` section in an `Attested Computation` body is recognised and presented distinctly from ordinary sections
- [x] The section appears in the Outline like any other heading
- [x] Live preview and read mode both handle it, and editing inside it behaves like editing any other body section
- [x] The heading carries no special treatment on a Concept of any other type
- [x] A Concept of this type with no `# Computation` section renders normally
- [x] All four gates green

## Resolution

`sunstone_shared::computation::computation_section` (over wasm as
`computationSection`) finds the section in an Attested Computation's body:
the first ATX heading `Computation` at any level, through the last non-blank
line before the next peer-or-higher heading, fences skipped. The editor marks
those lines (`cm-computation-section*`, live preview and reading); the native
render and the fake wrap them in `<section class="computation-section">`. The
heading is untouched otherwise, so it stays in the Outline and edits normally.
Along the way the editor's trust line and contract card wrappers became
`display: flow-root`: their child's margin had been left out of CodeMirror's
widget height, so a click below them landed one line low.
