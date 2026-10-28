---
type: Feature
title: Sunstone Web
description: "Serve a Bundle in any browser from a Docker image: read-only for visitors, the full editor for signed-in users."
tags: [web]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Sunstone Web

Sunstone Web serves a Bundle in the browser. It ships as a Docker image and runs on the same core as the desktop app, so pages render exactly as they do in the editor.

You're using it right now: this guide is served by Sunstone Web, read-only.

## For readers

Visitors get a server-rendered page with the same Explorer, [search](/navigating/search.md), tags, [outline and backlinks](/navigating/outline-and-backlinks.md) as the desktop app, plus [diagrams](/editing/diagrams.md), [images](/editing/images.md) and PDF export. Changes to the Bundle reach every open browser live.

It works on phones. Below 768 px the sidebars become slide-over drawers, the page takes the full width, and wide tables scroll on their own.

## For editors

Signed-in users (through OIDC) get the full editor in the browser. Saves are explicit, and when two people edit the same Concept, Sunstone tells you instead of overwriting someone's work. Without an auth configuration, every write is refused: a safe read-only default.

## Running it

The image takes a folder as the Bundle, or a git remote as described in [Git-synced wiki](/web/git-synced-wiki.md). Theme colours and fonts come from the same `config.json` format as the desktop (see [Customizing](/customize/)). Setup is covered in the [deployment guide](https://github.com/pothos-dev/sunstone/blob/main/docker/README.md).

```d2
direction: right
browser: Browser
server: Sunstone Web {
  ssr: Rendered pages
  api: Bundle API
}
bundle: Bundle folder or git clone
browser -> server
server -> bundle
```
