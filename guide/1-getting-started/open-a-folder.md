---
type: Guide
title: Open a folder
description: "Launch Sunstone on any directory of markdown from the command line or the launcher."
tags: [setup, cli]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Open a folder

Sunstone has no vault to create or import into. Any directory of markdown is a Bundle:

```sh
sunstone ./docs
```

Files stay plain `.md` on disk, and nothing is indexed into a database. Close the app and you're left with the same folder of markdown.

## Command line

| Command | What it does |
|---------|--------------|
| `sunstone ./docs` | Open the folder as a Bundle. |
| `sunstone ./docs guide/setup.md#install` | Open a Concept in the Bundle, scrolled to the heading. |
| `sunstone -d ./docs` | Launch detached from the terminal, so the prompt returns immediately. |
| `sunstone serve ./docs` | Serve the editor to a browser instead of opening a window (see [Run in the browser](/1-getting-started/run-in-browser.md)). |

## The launcher

Started without a path, Sunstone opens the launcher: the folders you've opened before, with a fuzzy filter. A folder with a root `index.md` is listed by that page's title. **New Bundle…** creates a fresh [OKF](/6-okf/okf-support.md) Bundle.

To switch Bundles without closing the editor, press **Ctrl/Cmd+O** or use the button in the left rail. Open Concepts are saved first.

## Where the Bundle starts

Links that start with `/` resolve from the Bundle root. Sunstone finds it in this order: a root `index.md` that declares `okf_version`, then the outermost `index.md`, then the git repository, then the folder you opened. To pick it yourself, right-click a folder in the [Explorer](/3-navigating/explorer.md) and choose **Set as Bundle Root**.
