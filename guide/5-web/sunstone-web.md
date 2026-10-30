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

Visitors get a server-rendered page with the same Explorer, [search](/3-navigating/search.md), tags, [outline and backlinks](/3-navigating/outline-and-backlinks.md) as the desktop app, plus [diagrams](/2-editing/diagrams.md), [images](/2-editing/images.md) and PDF export. Changes to the Bundle reach every open browser live.

It works on phones. Below 768 px the sidebars become slide-over drawers, the page takes the full width, and wide tables scroll on their own.

## Search engines and AI crawlers

A Sunstone Web that is reachable from the internet is meant to be found. Each page carries its frontmatter `description` as the meta description, a canonical URL and Open Graph tags, and the browser tab reads `<page> · <site>`, where the site name is the root `index.md`'s title. A URL that names no Concept answers `404`.

Three files at the root are generated from the Bundle:

- `/robots.txt` allows every crawler and points at the sitemap.
- `/sitemap.xml` lists every Concept at its page URL, dated by its `timestamp` when it has one.
- `/llms.txt` lists every page with its description, for AI assistants, and explains how to fetch any page as Markdown (see [Reading API](/5-web/reading-api.md)).

To keep a wiki private, limit who can reach it on the network.

## For editors

Signed-in users (through OIDC) get the full editor in the browser. Saves are explicit, and when two people edit the same Concept, Sunstone tells you instead of overwriting someone's work. Without an auth configuration, every write is refused: a safe read-only default.

## Running it

The image takes a folder as the Bundle, or a git remote as described in [Git-synced wiki](/5-web/git-synced-wiki.md). Theme colours and fonts come from the same `config.json` format as the desktop (see [Customizing](/7-customize/)). Setup is covered in the [deployment guide](https://github.com/pothos-dev/sunstone/blob/main/docker/README.md).

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
