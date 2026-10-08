---
status: done
blocked-by: [ov-5]
---

# ov-8: Declare `okf_version` on Bundles Sunstone creates

**What to build:** a Bundle created or first indexed by Sunstone identifies itself, so the next tool to open it — Sunstone included — finds the root on the first rung instead of guessing. Sunstone is a producer as well as a consumer, and writing the marker it now reads closes the loop.

The marker is the sole exception to "Reserved files carry no Frontmatter", so this is the one place the writer must emit a Frontmatter block into an `index.md`, and only at the Bundle root. An existing root `index.md` gets the key added without disturbing the rest of the file; one that already declares a version is left alone rather than silently upgraded.

- [x] Creating a Bundle writes a root `index.md` declaring the OKF version Sunstone targets
- [x] Adding the marker to an existing root `index.md` preserves its body and any other Frontmatter keys
- [x] An `index.md` that already declares `okf_version` is never rewritten, including when it names a different version
- [x] No non-root `index.md` ever gains Frontmatter
- [x] The Frontmatter Region stays hidden for Reserved files, with the root `index.md` marker handled as the documented exception
- [x] Unit tests cover create, add-to-existing and leave-alone; a Playwright case covers a freshly created Bundle rooting on its own marker
- [x] All four gates green

## Resolution

"Creating a Bundle" is an explicit action: **New Bundle…** in the launcher and
the Bundle switcher, beside **Open folder…**. It picks a folder, declares it, and
opens it (`Backend.createBundle(path)`: `create_bundle` on the desktop; the fake
replays the declaration onto its fixture after the reload; `http.ts` rejects it,
as Sunstone Web has no launcher). Merely opening or first indexing a folder
writes nothing: ADR 0009 gates OKF behaviour on the marker precisely so that
`sunstone ./notes` stays a plain folder, and writing it on open would defeat that.

The writer is pure and shared, `okf_marker::declare_okf_version(existing, title)`
in `sunstone-shared` (native `bundle::declare_okf_bundle`, wasm
`declareOkfVersion`), so there is no TS twin. It inserts `okf_version: "0.2"` as
the first Frontmatter line and keeps everything else byte-for-byte (CRLF too). It
returns `None` for a file that already has the key (any value) or whose
Frontmatter does not parse. It only ever receives the root `index.md`.

The Frontmatter Region criterion was overtaken by 977e101, which made the Region
show for reserved files (a documented deviation in `docs/okf/bundle.md`). The
marker therefore shows in that Region, and the docs record it as the one key
Sunstone writes into an `index.md`. Nothing was re-hidden.
