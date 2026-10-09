---
status: captured
priority: 2
---

# ov-20: Native Backlinks resolve links without the Bundle root

**What to build:** Backlinks on desktop and web resolve bundle-absolute links
against the detected (or user-set) Bundle root, like the fake backend and the
render already do.

Found in the 2026-10-09 nightly review: `crates/sunstone-native/src/index/links.rs`
`extract_links` calls `resolve_location` with no root, so links resolve against
the opened folder. The fake's `outboundLinks` (`src/lib/ipc/fake/links.ts`)
resolves through `resolveLinkIn` with the markers. Example: `README.md`,
`docs/index.md` and `docs/a.md`, with `docs/b.md` linking `/a.md`. The fake
shows a backlink on `docs/a.md`; the desktop does not. ov-5 claimed desktop,
web and fake agree. `docs/okf/bundle.md` and the ov-7 ticket describe the old
behaviour wrongly as "resolves against the detected root".

- [ ] `Index` builds a `BundleRoot` and resolves links through it
- [ ] An `index.rs` test with a nested root and a bundle-absolute backlink
