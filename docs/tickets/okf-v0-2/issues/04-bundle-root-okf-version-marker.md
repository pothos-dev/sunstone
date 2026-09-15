---
status: ready-for-agent
blocked-by: [01]
---

# 04: Trust the `okf_version` marker when finding the Bundle root

**What to build:** when a Bundle ships the one marker OKF actually sanctions, Sunstone believes it instead of guessing. v0.2 §12 permits `okf_version` in a bundle-root `index.md` frontmatter block and states it is the only place Frontmatter is permitted in a Reserved file — which makes an `index.md` carrying `okf_version` a positive, unambiguous root declaration. Sunstone's current root finder is deliberately structural: it infers from the path list alone and never reads Frontmatter, so it cannot see this marker and will still guess wrong on a Bundle that declares itself.

The seam is the interesting part. Root-finding is pure logic shared across the desktop backend, the web renderer and the Playwright fake, so the marker has to reach it as data — the finder must not grow IO. Feed it the parsed `okf_version` for candidate `index.md` files alongside the path list.

Treat the marker as a strong hint, not proof of absence: upstream issue #26 reports the reference agent's index regeneration silently dropping `okf_version`, so its absence must fall through to the existing heuristics rather than concluding there is no Bundle.

- [ ] A directory whose `index.md` Frontmatter declares `okf_version` is chosen as the Bundle root, overriding every structural heuristic
- [ ] When several ancestors declare it, the outermost wins — an inner declaration is treated as a nested Bundle, not the root
- [ ] A missing or unparseable `okf_version` falls through to today's structural rules with no behaviour change
- [ ] The root finder stays pure: no filesystem access added to the shared logic, and the desktop, web and fake backends agree
- [ ] Unit tests cover marker-present, marker-absent, nested-markers and malformed-Frontmatter cases
- [ ] The Bundle page documents the marker as the first rung of root detection
- [ ] All four gates green
