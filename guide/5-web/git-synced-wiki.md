---
type: Feature
title: Git-synced wiki
description: "Back a Sunstone Web deployment with a git remote so browser edits and pushes reconcile on their own."
tags: [web, git]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-28T18:00:00+01:00 }
sources:
  - id: changelog
    resource: https://github.com/pothos-dev/sunstone/blob/main/CHANGELOG.md
    title: Sunstone CHANGELOG
---

# Git-synced wiki

A [Sunstone Web](/5-web/sunstone-web.md) deployment can be backed by a git remote instead of a plain folder. The server clones the repository on startup, commits every save as the signed-in user, and keeps reconciling with the remote: it fetches, rebases and pushes. Edits made in the browser and changes pushed from a clone converge on their own. Nothing runs beside it: no sidecar, no hook, no manual step.

## Conflicts never block a save

It isn't real-time co-editing; concurrent work reconciles through rebase. When a browser edit and an incoming change touch the same Concept, the remote keeps the original name and your version is written beside it as an ordinary Concept (`notes/foo-20260727T101500Z.md`). It shows up in the tree, search and quick nav, and the editor tells you about it. History still holds every author's edit.

## Everything is git

Saves are committed as the signed-in user, with a message naming the change and the path, such as `edit concepts/rollout-plan.md via web`.

```sh
$ git log --format='%h %<(6)%an %s' concepts/
a41f2c9 Dana   edit concepts/rollout-plan.md via web
7be03d1 Jonas  rename concepts/rollout.md → concepts/rollout-plan.md via web
c02a7de Daniel Add rollback steps to the rollout plan
```

Syncing adds no commits of its own: rebasing replays the browser commits on top of the remote, so history stays linear. Anything the wiki did, you can inspect, revert or bisect from the command line. Changes pushed to the remote reach every connected reader within one sync interval.
