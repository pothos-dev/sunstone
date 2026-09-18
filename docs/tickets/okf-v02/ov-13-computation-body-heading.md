---
status: ready-for-agent
blocked-by: [ov-12]
---

# ov-13: The `# Computation` conventional body heading

**What to build:** the code in an `Attested Computation` is presented as the computation it is, rather than as an anonymous fenced block partway down the page. OKF v0.2 adds `# Computation` to its set of conventional body headings — the section holding the query or model the Concept attests to, alongside the prose that cites its sources.

This is the smallest change in v0.2 and deliberately last: it is presentation over a Concept type that must already parse. The heading is conventional, not required, so a Concept using it gains the affordance and one that does not loses nothing.

- [ ] A `# Computation` section in an `Attested Computation` body is recognised and presented distinctly from ordinary sections
- [ ] The section appears in the Outline like any other heading
- [ ] Live preview and read mode both handle it, and editing inside it behaves like editing any other body section
- [ ] The heading carries no special treatment on a Concept of any other type
- [ ] A Concept of this type with no `# Computation` section renders normally
- [ ] All four gates green
