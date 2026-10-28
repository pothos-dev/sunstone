---
type: Guide
title: Install
description: "Desktop installers for macOS, Windows and Linux, and how Sunstone keeps itself up to date."
tags: [install, update]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Install

Download the installer for your platform from the [latest release](https://github.com/pothos-dev/sunstone/releases/latest):

| Platform | Package |
|----------|---------|
| macOS | `.dmg` (Apple Silicon and Intel) |
| Windows | `.msi` or `.exe` |
| Linux | `.AppImage`, `.deb` or `.rpm` |

If you only want to try it, you don't need to install anything: see [Run in the browser](/getting-started/run-in-browser.md).

## Updates

Sunstone updates itself.[^changelog] On launch, the AppImage, macOS and Windows installs check for a newer release, download it in the background and run it from the next launch. On Windows the installer runs after you close Sunstone. `.deb` and `.rpm` installs are left to your package manager.

Set the environment variable `SUNSTONE_NO_UPDATE` to skip the check.

After an update, Sunstone shows what's new in the version you just got.
