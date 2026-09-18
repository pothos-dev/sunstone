---
status: ready
blocked-by: [ov-5]
---

# ov-6: Complete the Bundle root fallback ladder

**What to build:** a Bundle that ships no `okf_version` marker still roots predictably, and an unrootable folder degrades safely instead of mis-navigating. With the marker rung in place, the remaining rungs become explicit and ordered rather than an ad-hoc sequence of heuristics: after the marker, prefer the outermost directory in the chain of directories carrying an `index.md` — tolerating gaps, since an `index.md` is optional at every level — then the git repository toplevel, since OKF names git as the recommended distribution unit, and finally the opened folder itself, with bundle-absolute links degrading to resolving against the Concept's own directory.

Sunstone already implements something close for the middle rungs: shallowest directory with an `index.md`, a `docs/` tiebreak, and a shared-top-level-segment guess. This ticket restates them as a documented ladder, adds the git-toplevel rung, and keeps the existing safety property — a bundle-absolute link is only rewritten when the rewritten target actually exists, so a mis-identified root can never break a link that would otherwise have worked.

- [ ] Root detection runs as an ordered ladder whose rungs are named and individually testable
- [ ] When no marker exists, the outermost directory in an `index.md` chain wins, and a gap in the chain does not stop the walk
- [ ] A Bundle with no `index.md` anywhere roots at the git toplevel when the opened folder is inside a repository
- [ ] With every rung exhausted, bundle-absolute links resolve against the Concept's own directory and are styled broken only when genuinely absent
- [ ] The existence-gated rewrite guarantee still holds at every rung
- [ ] Unit tests cover each rung and each fallthrough, including the ambiguous-siblings case that must not guess
- [ ] The Bundle page's root-detection section describes the full ladder and where Sunstone extends the spec
- [ ] All four gates green
