---
status: done
blocked-by: [ov-6]
---

# ov-7: Let the user set the Bundle root explicitly

**What to build:** when detection gets the root wrong, the user fixes it once and it stays fixed. A command on a folder in the Explorer marks that folder as the Bundle root; bundle-absolute links immediately resolve from it, and the choice survives restarts. An override outranks every rung of the detection ladder — it is the user correcting the guess, so nothing re-derives over it.

The override is per-user preference about a Bundle, not content, so it belongs in View state and must never be written into the Bundle itself. Keying it by opened folder means a user who works across several Bundles keeps a separate correction for each.

- [x] A folder in the Explorer offers a command that makes it the Bundle root, and a way to clear the override back to automatic detection
- [x] The current root is visible to the user, and an active override is distinguishable from a detected root
- [x] The override persists across restarts, keyed by opened folder, on both desktop and web
- [x] The Bundle on disk is unchanged by setting an override
- [x] Changing the root re-resolves open bundle-absolute links without a reload
- [x] A Playwright case covers setting an override, following a bundle-absolute link under it, and clearing it
- [x] All four gates green

## Resolution

Rung 0 of the root ladder: `override_root` / `RootRung::Override` in
`sunstone-shared/src/bundle_root.rs`. `find_bundle_root` and the wasm
`BundleIndex` take an optional override that skips the ladder; an unclean path
is ignored. The override is View state (`BundleState.bundleRootOverride`), set
and cleared from an Explorer folder's menu (**Set as Bundle Root** / **Use
Detected Bundle Root**) and shown in the Explorer header (`/docs`, flagged when
the user set it). It never reaches the server, so no route needed guarding.
Playwright: `tests/bundle-root-override.spec.ts`.

Known limit: the native index's Backlinks extraction still resolves
bundle-absolute links against the detected root. The override applies to the
frontend's link resolution only.
