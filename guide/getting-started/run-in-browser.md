---
type: Guide
title: Run in the browser
description: "Use Sunstone without installing it with npx sunstone-md, or serve the desktop editor with sunstone serve."
tags: [cli, browser, serve, npx]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Run in the browser

You can run the full Sunstone editor in your browser instead of a desktop window.

## Without installing: `npx sunstone-md`

```sh
npx sunstone-md ./docs
```

This serves the editor at <http://localhost:3000/>. It runs on Linux, macOS and Windows; all you need is Node.

## With the desktop app: `sunstone serve`

```sh
sunstone serve ./docs --port 3000
```

Same editor, same behaviour. Saves are written to disk without committing, and git history still shows in [Review](/git/review-changes.md).

## Options

Both commands take the same options:

| Option | Effect |
|--------|--------|
| `--port PORT` | Listen on a different port. |
| `--browser`, `-b` | Open the editor in your default browser once it's ready. |
| `--bind ADDR` | Listen on an address other than localhost. |
| `--allow-host NAME` | Accept requests for this host name, e.g. behind a reverse proxy. |

There is no sign-in, so if you expose it beyond localhost, the proxy in front has to control access. For a shared, authenticated deployment, use [Sunstone Web](/web/sunstone-web.md).

## Links into the editor

URLs follow the open Concept. `/guide/setup#install` opens that Concept at the heading, so a copied address links straight back to what you were reading. Pages can also be fetched as [Markdown or JSON](/web/reading-api.md).
