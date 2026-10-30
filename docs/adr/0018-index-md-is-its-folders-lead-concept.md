---
type: Decision
title: "An `index.md` is its folder's lead Concept and may carry Frontmatter"
description: "Sunstone deliberately deviates from OKF §8: an index.md may carry Frontmatter such as title and description, because it is the page that introduces its folder, not only a list of links."
tags: [adr, decision, okf, deviation]
---

# An `index.md` is its folder's lead Concept and may carry Frontmatter

OKF v0.2 [§8](/okf/spec.md#8-index-files) says index files contain no Frontmatter, apart
from an `okf_version` key in the bundle-root `index.md`. In Sunstone a folder's `index.md`
does more than list the folder's contents. It is the folder's **lead Concept**: the page you
land on when you open the folder. It introduces the topic in prose, and its `title` and
`description` name and describe the folder. The Explorer and the Tile header label a folder
by its `index.md` `title`, and the Bundle header takes the Bundle's title from the root
`index.md`. That matters most when a folder name is chosen for sorting rather than reading
(`guide/5-web/` titled "Sunstone Web").

So we deviate from the spec on purpose: **any `index.md` may carry Frontmatter, with any
keys.** `sunstone lint` no longer reports it. A `log.md` still may not carry Frontmatter
(§9). The `index.md` stays a reserved file in every other respect. It is not asked for a
`type`, it still lists its folder's Concepts (§8), and the Explorer still shows it as the
folder rather than as a leaf.

## Considered Options

- **Frontmatter on `index.md` (chosen).** The folder's metadata lives in the file that
  already introduces the folder. Other producers do the same: Hjarni's OKF exporter writes
  `type: Collection` Frontmatter on every folder `index.md`. The spec itself is unsettled on
  the root index ([knowledge-catalog#212](https://github.com/GoogleCloudPlatform/knowledge-catalog/issues/212),
  [#214](https://github.com/GoogleCloudPlatform/knowledge-catalog/issues/214)).
- **A lead Concept named after its folder** (`web/web.md`, proposed upstream in
  [open-knowledge-format#10](https://github.com/GoogleCloudPlatform/open-knowledge-format/issues/10)).
  Rejected: it is conformant, but every folder gets a second entry page next to the
  `index.md`, and the two drift apart.
- **The `index.md`'s first heading as the folder title.** Rejected: §8's own example uses
  `#` headings for its sections, so the first heading is not reliably a title, and there is
  still nowhere for a `description`.

## Consequences

- A strict OKF linter (inkeep's `open-knowledge`, okf-skills) flags our folder indexes.
  We accept that and record the deviation in [Bundle → reserved files](/okf/bundle.md#reserved-files).
- An `index.md`'s Frontmatter is checked as YAML only (syntax, duplicate keys), not against
  the OKF field rules, because the Frontmatter lint's OKF mode demands a `type`.
- Sunstone writes no `index.md` Frontmatter of its own beyond `okf_version` (**New Bundle…**).
  Any other keys there are the author's.
