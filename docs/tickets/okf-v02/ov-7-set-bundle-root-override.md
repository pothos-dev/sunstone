---
status: ready
blocked-by: [ov-6]
---

# ov-7: Let the user set the Bundle root explicitly

**What to build:** when detection gets the root wrong, the user fixes it once and it stays fixed. A command on a folder in the Explorer marks that folder as the Bundle root; bundle-absolute links immediately resolve from it, and the choice survives restarts. An override outranks every rung of the detection ladder — it is the user correcting the guess, so nothing re-derives over it.

The override is per-user preference about a Bundle, not content, so it belongs in View state and must never be written into the Bundle itself. Keying it by opened folder means a user who works across several Bundles keeps a separate correction for each.

- [ ] A folder in the Explorer offers a command that makes it the Bundle root, and a way to clear the override back to automatic detection
- [ ] The current root is visible to the user, and an active override is distinguishable from a detected root
- [ ] The override persists across restarts, keyed by opened folder, on both desktop and web
- [ ] The Bundle on disk is unchanged by setting an override
- [ ] Changing the root re-resolves open bundle-absolute links without a reload
- [ ] A Playwright case covers setting an override, following a bundle-absolute link under it, and clearing it
- [ ] All four gates green
