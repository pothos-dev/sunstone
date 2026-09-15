---
status: ready-for-agent
blocked-by: [04]
---

# 07: Declare `okf_version` on Bundles Sunstone creates

**What to build:** a Bundle created or first indexed by Sunstone identifies itself, so the next tool to open it — Sunstone included — finds the root on the first rung instead of guessing. Sunstone is a producer as well as a consumer, and writing the marker it now reads closes the loop.

The marker is the sole exception to "Reserved files carry no Frontmatter", so this is the one place the writer must emit a Frontmatter block into an `index.md`, and only at the Bundle root. An existing root `index.md` gets the key added without disturbing the rest of the file; one that already declares a version is left alone rather than silently upgraded.

- [ ] Creating a Bundle writes a root `index.md` declaring the OKF version Sunstone targets
- [ ] Adding the marker to an existing root `index.md` preserves its body and any other Frontmatter keys
- [ ] An `index.md` that already declares `okf_version` is never rewritten, including when it names a different version
- [ ] No non-root `index.md` ever gains Frontmatter
- [ ] The Properties panel stays hidden for Reserved files, with the root `index.md` marker handled as the documented exception
- [ ] Unit tests cover create, add-to-existing and leave-alone; a Playwright case covers a freshly created Bundle rooting on its own marker
- [ ] All four gates green
