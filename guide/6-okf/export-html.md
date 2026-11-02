---
type: Guide
title: Export a Bundle as HTML
description: "Write a Bundle as a folder of static HTML pages with an Explorer, to open from disk or put on any web server, with sunstone export."
tags: [okf, cli]
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-02T12:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Export a Bundle as HTML

`sunstone export` writes a Bundle as a folder of HTML pages, one per Concept. Hand someone the folder and they can read it with only a browser: they open `index.html` from disk, with no Sunstone and no server.

```sh
sunstone export ./docs --out ./site
```

`guide/setup.md` becomes `site/guide/setup.html`, and every link between pages is relative, so the folder also works when you copy it to any web server path.

Each page shows:

- the Concept as it reads in [Sunstone Web](/5-web/sunstone-web.md): [links](/2-editing/links.md) and Wikilinks, [images](/2-editing/images.md), [comments](/2-editing/comments.md), [footnotes and sources](/2-editing/footnotes-and-sources.md)
- an Explorer of the whole Bundle, with folders labelled and opened by their `index.md`, as in the [Explorer](/3-navigating/explorer.md)
- the folders above it, its Frontmatter (collapsed), and the pages that link to it
- Sunstone's fonts and colours, light or dark following the system, with a toggle

The pages need no JavaScript. With it, they add the dark-mode toggle, an Explorer drawer on narrow screens, and click-to-load for remote images, as on Sunstone Web.

Without a root `index.md`, `index.html` is a generated list of every page.

## Leaving files out

`--exclude PATTERN` (or `-x`) leaves matching Concepts and images out of the export. Links to them show as broken. Patterns use gitignore syntax, relative to the Bundle, and the option can be repeated:

```sh
sunstone export docs -o site --exclude tickets/ --exclude drafts/
```

## The output folder

The output folder must be new, empty, or an earlier export, which is replaced as a whole. Sunstone refuses any other folder that has files in it, and any folder inside the Bundle.

## Not yet exported

- [Diagrams](/2-editing/diagrams.md) show as their source code.
- A link to a heading on another page opens that page at the top.
- There is no search; use the browser's find on the page.
