---
status: decide
priority: 1
---

# ov-21: "New Bundle…" can declare nothing and say nothing

**What to build:** creating a Bundle over an existing root `index.md` either
declares `okf_version` or tells the user why it did not.

Found in the 2026-10-09 nightly review. `declare_okf_version`
(`crates/sunstone-shared/src/okf_marker.rs`) returns `None` when the block
already has the key with an empty value (`okf_version:` or `""`), and when the
Frontmatter does not parse. The empty case is deliberate and tested
(`leaves_an_existing_declaration_alone_even_another_version`), but
`okf_version_of` reads an empty value as no marker, so the new Bundle does not
root on its marker. `create_bundle` (`src-tauri/src/commands.rs`) ignores the
result, so the user gets no feedback either way.

Open: should an empty value count as absent and be filled, and should a
refusal be an error or a notice?

- [ ] `declare_okf_version` returns a three-way result instead of `Option<String>`: write this content, already declared (with the version), or refused (with a reason). The wasm `declareOkfVersion` export returns the same shape, so the fake and the desktop give the same answer and the same text
- [ ] Every case where the root `index.md` ends up without a marker `okf_version_of` reads is a refusal with a reason naming `index.md` and what is wrong (Frontmatter does not parse; Frontmatter is not a mapping; `okf_version` is not a version string or number), except the cases Q1 decides to fill
- [ ] An `index.md` that already declares a readable version (`"0.1"`, `0.3`) is "already declared": nothing written, no message, the Bundle opens and roots on it (unchanged ov-8 behaviour)
- [ ] A refusal reaches the user in the launcher and the Bundle switcher, as Q2 decides
- [ ] The fake's `createBundle` evaluates the declaration before the reload, so it can refuse the same way (today it declares after the reload, in `ensureIndexReady`)
- [ ] Rust goldens in `okf_marker.rs` for each outcome; `bundle.rs` `declare_okf_bundle` tests; `src/lib/ipc/fake/createBundle.test.ts` cases; a `tests/bundle-switcher.spec.ts` case for a refusal
- [ ] All four gates green, after `bun run build:wasm`

## Grounding

- Writer: `crates/sunstone-shared/src/okf_marker.rs` `declare_okf_version`
  returns `None` when the block's mapping `contains_key("okf_version")`,
  whatever the value, and when the YAML does not parse to a mapping. Tests:
  `leaves_an_existing_declaration_alone_even_another_version` (includes
  `okf_version:` with no value), `leaves_unparseable_frontmatter_alone`.
- Reader: `crates/sunstone-shared/src/frontmatter.rs:302` `okf_version_of`
  accepts a non-empty trimmed string or a number. `okf_version:` (null), `""`,
  `"  "`, a list, a map or a bool are no marker. `docs/okf/bundle.md` rung 1
  says the same ("an empty value, a list, unparseable YAML, no Frontmatter
  counts as no marker"). So the writer's "already declared" and the reader's
  "declared" disagree for every one of those values, not only the empty ones.
- Native caller: `crates/sunstone-native/src/bundle.rs:203`
  `declare_okf_bundle` returns `Ok(false)` on `None`;
  `src-tauri/src/commands.rs:105` `create_bundle` discards the bool and opens
  the folder.
- Frontend: `Backend.createBundle(path): Promise<void>` (`src/lib/ipc/backend.ts:102`).
  `src/lib/components/Launcher.svelte:79` and `BundleSwitcher.svelte:102`
  `await` it, then `location.reload()`; a rejection already shows in their
  `error` line and leaves the picker open. `http.ts` rejects `createBundle`
  outright (Sunstone Web has no launcher). The fake (`src/lib/ipc/fake.ts:324`)
  only records the created path; `fake/createBundle.ts` `declareRootIndex`
  runs after the reload.
- In-editor notices exist (`treeActions.notify`, the rewrite toast), but
  nothing carries a message across the `location.reload()`.
- ov-8's Resolution: "returns `None` for a file that already has the key (any
  value) or whose Frontmatter does not parse"; "A declaration is never
  upgraded". Filling an empty value is not an upgrade, but it does reverse a
  tested choice, hence Q1.

## Open questions

1. **Is an empty `okf_version` (`okf_version:`, `""`, whitespace) filled?**
   (a) Yes: replace that key's value in place with `"0.2"`, keeping its line
   position, other keys and the body byte-for-byte. (b) No: it stays alone and
   is reported as a refusal ("`okf_version` is empty"). Recommendation: **(a)**.
   The reader already treats empty as absent, so it is not a declaration and
   filling it upgrades nothing; the user asked for a Bundle and gets one.
   Non-empty unreadable values (a list, a map, `true`) are refused either way:
   overwriting a value someone wrote is a guess.
2. **How does a refusal reach the user?** (a) An error: `create_bundle` (and
   the fake) rejects with the reason before opening anything; the launcher or
   switcher shows it in its error line and stays put; the user fixes
   `index.md` or uses **Open folder…**. (b) A notice: the folder opens anyway
   and a toast after the reload says it was not declared and why (needs the
   message carried across the reload, e.g. `sessionStorage`, like the fake's
   created-bundle marker). Recommendation: **(a)**. It uses the error line that
   already exists, nothing is half-done, and "New Bundle" that opens a folder
   which is not an OKF Bundle is the confusion this ticket is about.

## Decisions

- Result shape → an enum in `okf_marker.rs` (`Write(String)`,
  `Declared(String)`, `Refused(reason)`), with the reason text produced in Rust
  so desktop and fake match (ADR 0006). The bool of `declare_okf_bundle`
  becomes that enum or a `Result`.
- An existing readable version, even another one → "already declared", silent.
  ov-8's never-upgrade rule stands, and the Bundle roots on its marker.
- Unparseable or non-mapping Frontmatter → refused, never repaired. Same
  reasoning as ov-8: inserting into YAML Sunstone cannot read makes it worse.
- No new route: Sunstone Web still rejects `createBundle`.
