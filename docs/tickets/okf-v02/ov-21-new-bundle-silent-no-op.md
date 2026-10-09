---
status: captured
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
