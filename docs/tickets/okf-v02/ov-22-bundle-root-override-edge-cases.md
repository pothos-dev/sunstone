---
status: captured
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
  Root".
- `session.svelte.ts` remaps the override on rename and move, not on delete.
  A deleted folder stays as the override and the header shows it as "set by
  you". Links still work, because every rung is existence-gated.
