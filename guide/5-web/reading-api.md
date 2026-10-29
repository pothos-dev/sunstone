---
type: Feature
title: Reading API
description: "Fetch any page as Markdown or JSON, list a folder, or search, from scripts and agents."
tags: [web, agents]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Reading API

Every page URL doubles as an API. Ask for a different content type and you get the Concept as data instead of HTML. Browsers still get the normal page. This works on [Sunstone Web](/5-web/sunstone-web.md) and under [`sunstone serve`](/1-getting-started/run-in-browser.md), which makes a Bundle easy for agents and scripts to read.

| Request | `Accept` | Response |
|---------|----------|----------|
| `GET /path/to/page` | `text/markdown` | The raw file, frontmatter included. |
| `GET /path/to/page` | `application/json` | Frontmatter, body, outbound links and backlinks. |
| `GET /folder?list` | `application/json` | Every Concept under the folder: path, title, description, type, tags. Filter with `&type=` or `&tag=`. `/?list` lists the whole Bundle. |
| `GET /folder?q=text` | `application/json` | Full-text search under the folder, with line numbers and snippets. |

Without one of these `Accept` headers, you get the normal HTML page.

# Examples

Try it on this guide:

```sh
curl -H 'Accept: text/markdown' https://wiki.sunstone.pothos.dev/5-web/reading-api
curl -H 'Accept: application/json' https://wiki.sunstone.pothos.dev/2-editing/links
curl -H 'Accept: application/json' 'https://wiki.sunstone.pothos.dev/2-editing?list'
```
