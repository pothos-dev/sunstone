---
name: deploy
description: Cut a new release of Sunstone. Bumps the version across all manifests, updates CHANGELOG.md, commits, tags, and pushes — the pushed tag triggers the GitHub Actions release workflow that builds installers for Linux, macOS, and Windows — then publishes the marketing page (sunstone.pothos.dev) and the user guide wiki (wiki.sunstone.pothos.dev) for that version. Use when the user runs /deploy or asks to release/ship/cut a new version.
---

# /deploy

Cuts a new Sunstone release. The release artifacts (Linux `.deb`/`.AppImage`, macOS `.dmg`, Windows `.msi`/`.exe`) are built by `.github/workflows/release.yml`, which runs on every pushed `v*` tag via `tauri-action`. This skill's job is to bump the version, write the changelog, push the tag that triggers that build, and then publish the two public sites for the new version: the marketing page at https://sunstone.pothos.dev (`marketing/`) and the user guide at https://wiki.sunstone.pothos.dev (the `guide/` OKF bundle, served by Sunstone Web). Both are hosted on `debian.local`, the machine this skill runs on.

## When to invoke

Only on explicit user request (`/deploy`, "deploy", "cut a release", "ship a new version"). Never run as a side effect of other work.

## Preconditions — verify before doing anything

1. **On `main` and clean.** Run `git status` and `git rev-parse --abbrev-ref HEAD`. If the branch is not `main` or there are uncommitted changes (other than test-screenshot churn the user explicitly waves through), stop and tell the user. Do not stash or auto-commit unrelated work.
2. **`main` is up to date with `origin/main`.** `git fetch origin` then `git rev-list --left-right --count origin/main...main`. If `origin` is ahead, stop. If `main` is ahead, that's fine — those commits ship in this release and get pushed in Phase 4.
3. **The release workflow exists.** Confirm `.github/workflows/release.yml` is present. If missing, stop — there is nothing to trigger.

If any precondition fails, stop and report — do not try to "fix it up" silently.

## Phase 1 — Choose the version bump

Read the current version from `package.json` (`.version`). Get the latest tag with `git describe --tags --abbrev=0` (may be absent on the first release).

Ask the user via `AskUserQuestion` which bump to apply:

- **Patch** (X.Y.Z → X.Y.Z+1) — bugfixes only
- **Minor** (X.Y.Z → X.Y+1.0) — new features, backwards-compatible
- **Major** (X+1.0.0) — breaking changes

Compute the new version and confirm it back in plain text before proceeding (e.g. "Bumping 0.9.0 → 0.10.0").

## Phase 2 — Summarize changes for the CHANGELOG

Collect the commits since the last tag (or the full history on the first release):

```bash
git log --oneline <last-tag>..HEAD   # or: git log --oneline   (first release)
```

Group them into `### Added`, `### Changed`, `### Fixed`, `### Removed` based on commit messages. Skip purely internal commits (refactors with no user-visible effect, "fix typo", test-retry tweaks). Focus on user-visible behavior; when unsure, lean toward including.

**Record only user-relevant changes.** The changelog is user-facing: it becomes the GitHub release notes, and the desktop app embeds it and shows the new sections in a "What's new" dialog on the first start after an update. So every entry must describe something the user actually experiences. Drop anything internal even if the commit is a `feat`/`refactor`: code or terminology renames (e.g. Pane→Tile "to match the glossary"), internal restructuring, and doc/glossary/wayfinder commits never belong here. When an entry only makes sense to someone reading the source, cut it.

Prepend a new section to `CHANGELOG.md` (Keep a Changelog style), using today's date in ISO format:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- ...

### Fixed
- ...
```

**Check the guide and the landing page.** For each `### Added` entry, check that `guide/` covers it: grep for it, and if no page describes it, add or extend a page (follow the `/llm-wiki` conventions: one feature per page, link it from its folder's `index.md`, update `generated`, then `bun ~/.claude/skills/llm-wiki/scripts/lint.ts guide`). Changed or removed behaviour must be corrected in the guide too. When an entry is a big-ticket feature, propose a line or card for `marketing/index.html` as well; the landing page stays short and defers detail to the guide, so don't add minor features there. Show the guide and landing changes alongside the changelog draft; they ship in the release commit.

Always print the drafted section **verbatim** as a message to the user (in a fenced `markdown` block, exactly as it will land in `CHANGELOG.md`) *before* asking whether to ship. Do this every time, even when the user already chose the bump or said to just release: the question alone, or a paraphrase or summary of the entries, is not enough. Then ask for confirmation/edits **in plain text at the end of that same message and end your turn** — do **not** use `AskUserQuestion` for this step: its dialog hides the message text above it, so the user never sees the notes. Wait for the reply. After any edit, print the revised section verbatim again and ask the same way. Edits often happen here, so be ready to revise.

## Phase 3 — Bump, commit, tag

After the CHANGELOG is approved, set the new version in **all eight** places (use `Edit`, not version-bump tooling, so the diff stays predictable):

1. `package.json` — `.version`
2. `src-tauri/tauri.conf.json` — `.version`
3. `src-tauri/Cargo.toml` — `[package] version`
4. `crates/sunstone-server/Cargo.toml` — `[package] version` (reported by the web server's `GET /_api/version`)
5. `Cargo.lock` — the `version` under `[[package]] name = "sunstone"`
6. `Cargo.lock` — the `version` under `[[package]] name = "sunstone-server"`
7. `crates/sunstone-cli/Cargo.toml` — `[package] version` (what `npx sunstone-md --version` prints)
8. `Cargo.lock` — the `version` under `[[package]] name = "sunstone-cli"`

Also update the version label on the landing page: in `marketing/index.html`, the line marked `data-release` shows the version twice (the link text and the `releases/tag/vX.Y.Z` URL). Replace both.

Keep all eight in lockstep — a mismatch makes `tauri-action` produce wrongly-named artifacts. The npm packages need no bump: `release.yml` stamps them with the tag's version. Do not run `bun install` (the lockfile doesn't change for a self-version bump).

Then:

5. Stage the manifest files, `CHANGELOG.md`, `marketing/index.html` and any `guide/` changes.
6. Commit: `Release vX.Y.Z`.
7. Tag: `git tag vX.Y.Z` (note the `v` prefix — the workflow triggers on `v*`).

## Phase 4 — Push

Push the branch and the tag as **separate** commands so a failure is easy to attribute:

```bash
git push origin main
git push origin vX.Y.Z
```

The tag push is what starts the release build.

## Phase 5 — Hand off to GitHub Actions

Print this to the user, verbatim, with the version and repo filled in:

> Release **vX.Y.Z** pushed. GitHub Actions is now building installers for Linux, macOS (Intel + Apple Silicon), and Windows.
>
> Watch the run: https://github.com/pothos-dev/sunstone/actions
>
> The workflow builds all platforms, uploads them to a draft, then **auto-publishes** the release once every build succeeds — with the CHANGELOG section for this version as the release notes. It'll appear at https://github.com/pothos-dev/sunstone/releases when the run finishes. If any platform build fails, it stays a draft.

The workflow (`.github/workflows/release.yml`) runs three jobs: `create-release` opens a draft whose body is this version's `CHANGELOG.md` section, `build-tauri` uploads each platform's installers to that draft, and `publish-release` flips it to published once all builds pass. Assets land on the draft first, so a failed platform never leaves a partially-populated public release. Each build also signs its updater artifacts with the `TAURI_SIGNING_PRIVATE_KEY` secret and merges itself into the release's `latest.json`, the feed installed copies poll to update themselves silently. Publishing is what makes it live: `releases/latest` only ever points at a published release. No manual publish step is needed — but this is also why the CHANGELOG section (Phase 2) must be correct before tagging: it becomes the public release notes verbatim.

## Phase 6 — Publish the marketing page and the guide

Run these on `debian.local` right after the tag push, from the repo root.

1. **Marketing page.** Caddy serves `/opt/docker/caddy/sites/sunstone/` as static files (`/opt/docker/caddy/Caddyfile`):

   ```bash
   rsync -a --delete marketing/ /opt/docker/caddy/sites/sunstone/
   curl -s https://sunstone.pothos.dev/ | grep -o 'releases/tag/v[0-9.]*'   # must show vX.Y.Z
   ```

2. **Guide bundle.** The read-only Sunstone Web container in `/opt/docker/sunstone-wiki` serves `./bundle`, which holds `guide/` exactly as of the release tag:

   ```bash
   B=/opt/docker/sunstone-wiki/bundle
   find "$B" -mindepth 1 -delete
   git archive vX.Y.Z guide | tar -x --strip-components=1 -C "$B"
   ```

   Then restart the container so it rebuilds its index from scratch: `cd /opt/docker/sunstone-wiki && docker compose restart`. (The file watcher would pick up most changes, but before v0.30.2 it could miss files in folders created in bulk, and a restart costs a second.) Check a page: `curl -s -o /dev/null -w '%{http_code}\n' https://wiki.sunstone.pothos.dev/`.

3. **Wiki image.** The tag also triggers `.github/workflows/publish-web-image.yml`, which pushes `ghcr.io/pothos-dev/sunstone-web:latest`. Once that run succeeds (`gh run list --workflow publish-web-image.yml --limit 1`, or `gh run watch <id>` in the background), update the container:

   ```bash
   cd /opt/docker/sunstone-wiki && docker compose pull && docker compose up -d
   curl -s https://wiki.sunstone.pothos.dev/_api/version   # must show X.Y.Z
   ```

   If the image build fails, say so; the guide content is already live on the previous image.

Add a line to the Phase 5 hand-off saying the landing page and guide are updated (or which step is still pending).

## Failure handling

- If a push fails, do **not** delete the tag locally as "cleanup" — the user may want to retry. Report and stop.
- If the build fails after the tag is pushed, fix forward with a new patch tag; never rewrite or force-push an existing tag.
- If the user aborts mid-way (e.g. after the version bump but before push), leave local state as-is and tell them exactly what was done so they can resume or undo manually. Don't `reset --hard`.

## What this skill never does

- Never force-pushes `main` or any tag.
- Never amends or rewrites an existing tag.
- Never runs the Tauri build locally — that happens in GitHub Actions.
- Never edits CHANGELOG entries for previously released versions.
