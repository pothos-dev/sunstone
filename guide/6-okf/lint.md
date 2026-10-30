---
type: Guide
title: Lint a Bundle
description: "Check a Bundle's links, footnotes, Frontmatter and OKF conformance from the command line with sunstone lint."
tags: [okf, cli]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-30T15:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Lint a Bundle

`sunstone lint` checks a Bundle and exits, so you can run it before a commit or in CI.

```sh
sunstone lint ./docs
```

It reports:

- broken links, anchors, Wikilinks and Embeds
- footnotes that are referenced but never defined
- malformed [Frontmatter](/2-editing/frontmatter.md)
- in a Bundle that declares `okf_version`, OKF conformance: a Concept without a `type`, Frontmatter on a `log.md`, a Concept its folder's `index.md` doesn't list, and sources that point at nothing

The Frontmatter checks are the ones the editor shows, so the command line and the app always agree.

An `index.md` may carry Frontmatter even though the OKF spec says it shouldn't. Sunstone treats it as the page that introduces its folder, so its `title` names the folder in the [Explorer](/3-navigating/explorer.md).

Without a folder argument it checks `$SUNSTONE_BUNDLE`, or else the current directory.

## Excluding files

`--exclude PATTERN` (or `-x`) skips files: nothing is reported in them, but links into them still resolve. Patterns use gitignore syntax, relative to the Bundle, and the option can be repeated:

```sh
sunstone lint docs --exclude tickets/ --exclude 'adr/*.md'
```

## In CI

The exit status is 0 when there are no errors (warnings and info don't count), 1 when there are errors, and 2 on a usage error. Add `--json` to get the report as JSON.
