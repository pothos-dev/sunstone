---
status: decide
priority: 2
---

# ov-22: Bundle-root override accepts folders it then ignores

**What to build:** "Set as Bundle Root" is only offered where the override will
take effect, and an override whose folder is gone stops claiming to be in
force.

Found in the 2026-10-09 nightly review:

- `treeCrud.ts` offers the item on every folder. A folder with a `.` segment or
  a `\` in its name (possible on Linux) is persisted, then rejected by
  `override_root` (`crates/sunstone-shared/src/bundle_root.rs`). The header
  keeps showing the detected rung while the menu offers "Use Detected Bundle
  Root". (Narrowed while grounding: the walker skips hidden entries, so a
  dot-folder never reaches the Explorer on desktop or web. The reachable case
  is a `\` in a folder name. The fix covers both.)
- `session.svelte.ts` remaps the override on rename and move, not on delete.
  A deleted folder stays as the override and the header shows it as "set by
  you". Links still work, because every rung is existence-gated.

- [ ] The "is this a usable override?" check is one shared Rust predicate, factored out of `override_root` and exported through wasm (`isCleanRootDir` or similar); `override_root` calls it
- [ ] `menuItemsFor` offers "Set as Bundle Root" only on folders that pass it (`treeCrud.test.ts`: a folder named `a\b` gets no item, its parent does)
- [ ] A persisted override that fails the predicate (written before this fix) is dropped to `null` when the session hands it to `indexStore.setRootOverride`, so the header and the menu agree
- [ ] A deleted override folder is handled as Q1 decides; afterwards the header shows the detected rung, and "Use Detected Bundle Root" is only offered while an override is in force
- [ ] Deleting an ancestor of the override folder counts as deleting it
- [ ] `tests/bundle-root-override.spec.ts` case: set an override, delete that folder, the header no longer says "set by you"
- [ ] All four gates green, after `bun run build:wasm`

## Grounding

- Menu: `src/lib/treeCrud.ts:90` `menuItemsFor(node, root)` pushes
  `setBundleRoot` whenever `root.override !== node.path`, and `clearBundleRoot`
  whenever `root.override !== null`. The context is
  `{ override: session.bundleRootOverride }` from
  `src/lib/components/TreeCrud.svelte:132`: the persisted value, not whether
  it took effect.
- Finder: `override_root` (`bundle_root.rs`) accepts `''` or segments that are
  non-empty, not dot-prefixed and contain no `\`; otherwise `None` and the
  ladder runs. "The folder need not exist or hold an `index.md`." The effective
  rung reaches the UI as `indexStore.rootRung()` (`src/lib/state/index.svelte.ts`),
  and `src/lib/bundleRootLabel.ts` prints "set by you" for `override`.
- Walker: `crates/sunstone-native/src/paths.rs` `bundle_walker` sets
  `.hidden(true)`, so `.foo/` is never in the tree. `\` is a legal Linux
  filename character and passes through.
- Session: `src/lib/state/session.svelte.ts` `followRename` remaps the override
  (with `expandedFolders` and `recentFiles`) through `remapPaths`;
  `setBundleRootOverride` persists at once. There is no delete counterpart for
  any of the three. `treeActions.deletePath` (`src/lib/state/treeActions.svelte.ts`)
  leaves the follow-up to the watcher's `removed` event in `App.svelte`.
- App wiring: `src/lib/App.svelte:572` `indexStore.setRootOverride(session.bundleRootOverride)`.
- Tests: `src/lib/treeCrud.test.ts`, `src/lib/state/sessionState.test.ts` /
  session tests, `src/lib/bundleRootLabel.test.ts`, `bundle_root.rs` goldens,
  `tests/bundle-root-override.spec.ts`.

## Open questions

1. **What happens to an override whose folder is gone?** (a) Clear it only
   when the folder (or an ancestor) is deleted through Sunstone, a
   `followDelete` beside `followRename`; a folder removed in a shell stays the
   override. (b) Clear it whenever the folder is no longer in the tree, checked
   on every tree refresh; this covers Sunstone deletes and external ones
   (`rm`, `git checkout` of a branch without it) in one place, and the user
   re-sets it with one right-click if it comes back. (c) Keep it persisted but
   dormant: the finder ignores an override whose folder is missing and it comes
   back on its own when the folder does; this needs folder existence as finder
   input, which the concept/attachment path set only approximates (an empty
   folder would look missing). Recommendation: **(b)**. One rule, no new finder
   input, and the header stops claiming an override the moment the folder
   disappears, however it disappeared.

## Decisions

- The menu predicate → the shared Rust check over wasm, not a TS regex (ADR
  0006); `treeCrud.ts` stays pure and calls the export the way other pure
  modules do.
- "Use Detected Bundle Root" → offered while the persisted override is
  non-null, which after the two fixes above means "in force". No separate rung
  check needed in the menu.
- Unclean persisted values → dropped, not kept dormant. They can never take
  effect, and keeping them is what makes header and menu disagree today.
- Expanded folders and recent files on delete → out of scope. They are
  harmless when stale; only the override makes a false claim in the UI.
