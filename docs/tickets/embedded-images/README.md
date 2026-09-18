# Embedded images

Make image files stored in a Bundle render inside the Concept that embeds them,
in reading mode, hybrid mode and the server-rendered web view. Today both
`![alt](path.png)` and `![[name.png]]` show as raw text: link extraction drops
`!`-prefixed matches on purpose, and `![[ … ]]` embeds were deferred by
[ADR-0004](/adr/0004-wikilinks-optional-secondary-name-based.md).

Decisions that bind both tickets:

- **This is a Sunstone extension, not OKF.** The spec says nothing about images,
  media or attachments — §3 describes a Bundle as a tree of markdown files and
  leaves non-`.md` files unspecified rather than forbidden. So the behaviour
  belongs in the deviation table in [`docs/okf/bundle.md`](/okf/bundle.md).
- **Obsidian is the reference behaviour**, for the reason ADR-0004 gives: the
  Bundles that carry embeds came from Obsidian vaults. The one divergence from
  the wikilink grammar is that `|` in an embed is a size, not an alias.
- **The bytes cross the seam.** The frontend cannot reach the filesystem, so
  each shell resolves an embed to something loadable — a scoped asset URL on
  desktop, a server route on web — behind one `Backend` method that `tauri.ts`,
  `fake.ts` and `http.ts` all implement. Every resolved path stays confined to
  the Bundle root.
- **Rendering follows the Diagram precedent** in
  [ADR-0005](/adr/0005-mermaid-block-rendering.md): a widget in reading and
  hybrid mode, raw source under the cursor, plain text in source mode, with
  stable decoration identity so an image is not re-decoded on every keystroke.

Out of scope: editing or generating images, pasting an image into a Concept, and
any embed of a non-image file type.
