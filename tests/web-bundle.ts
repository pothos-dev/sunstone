/**
 * Shared constants + setup for the WEB e2e runner (`playwright.web.config.ts`).
 *
 * Ticket 09 requires the served fixture Bundle to be a **real git repo** so a web
 * Save lands a real commit the specs can assert (`git log`). A nested `.git` inside
 * `tests/fixtures/web-bundle` would collide with the outer Sunstone repo (and
 * pollute it), so instead the runner's `globalSetup` copies the read-only fixture
 * to a **throwaway temp dir** and `git init`s a seeded repo there **at test time**.
 * The Rust server (and the specs) point at that temp copy, never the in-repo
 * fixture. This survives a clean checkout (the temp copy is created fresh each run)
 * AND repeated runs (setup wipes + rebuilds the temp dir every time), and it leaves
 * the outer repo untouched.
 *
 * Everything the config, the global-setup, and the web-*.spec.ts files must agree
 * on lives here so there is a single source of truth (the temp path, the shared
 * secrets, the known test identity).
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The read-only fixture Bundle checked into the repo (never mutated at runtime). */
export const FIXTURE_SRC = resolve('tests/fixtures/web-bundle');

/**
 * The temp copy the web e2e server actually serves — a real git repo. A fixed
 * path (not a random one) so the config, global-setup, and specs all resolve the
 * same location without passing state between processes; `setupWebBundleRepo()`
 * wipes + recreates it each run, so repeated runs start clean.
 */
export const WEB_BUNDLE_DIR = join(tmpdir(), 'sunstone-web-bundle');

/**
 * The branch the seeded repo is created on. The server runs the **git-local**
 * shape over it (`SUNSTONE_GIT_BRANCH`), whose boot refuses a repo on any other
 * branch — so both sides read it from here.
 */
export const WEB_BUNDLE_BRANCH = 'main';

/**
 * Shared HS256 secret for the write JWT: the SvelteKit hook mints with it
 * (`SUNSTONE_JWT_SECRET`), axum verifies with it. Must be identical on both
 * servers or every authed write 401s.
 */
export const TEST_JWT_SECRET = 'web-e2e-jwt-secret';

/** Auth.js session-cookie secret (distinct from the write-JWT secret). */
export const TEST_AUTH_SECRET = 'web-e2e-auth-secret';

/**
 * The fixed identity the env-gated test Credentials provider yields (see
 * `src/auth.ts`). Later web-write specs assert this as the git commit author.
 */
export const TEST_AUTH_NAME = 'Web Test User';
export const TEST_AUTH_EMAIL = 'web-test@example.com';

/** Run a git subcommand in `cwd`, throwing (with output) on failure. */
function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * Wipe + rebuild {@link WEB_BUNDLE_DIR} as a fresh git repo seeded from the
 * read-only fixture: copy the fixture, `git init`, pin a deterministic identity,
 * disable commit signing (CI/sandbox has no key), and land one seed commit so
 * `HEAD` exists (the amend-else-fresh write path needs a HEAD to inspect).
 *
 * The reset is done **in place** — clearing the directory's CONTENTS rather than
 * `rmSync`-ing the directory itself — so the root inode survives. Playwright can
 * start the `webServer`s (the Rust server begins watching this path) *before*
 * `globalSetup` runs, so deleting-and-recreating the directory would orphan the
 * server's recursive `inotify` watch and silently kill `/api/events` SSE
 * delivery (breaking every live-reload / concurrency spec while leaving the
 * write+commit path working). Keeping the root inode keeps the watch live.
 *
 * Idempotent across runs. Returns the served bundle path.
 */
export function setupWebBundleRepo(): string {
  // Clear contents in place (preserve the root inode — see doc comment) rather
  // than removing WEB_BUNDLE_DIR itself.
  mkdirSync(WEB_BUNDLE_DIR, { recursive: true });
  for (const entry of readdirSync(WEB_BUNDLE_DIR)) {
    rmSync(join(WEB_BUNDLE_DIR, entry), { recursive: true, force: true });
  }
  cpSync(FIXTURE_SRC, WEB_BUNDLE_DIR, { recursive: true });

  git(WEB_BUNDLE_DIR, ['init', '-q', '-b', WEB_BUNDLE_BRANCH]);
  git(WEB_BUNDLE_DIR, ['config', 'user.name', 'Fixture Seed']);
  git(WEB_BUNDLE_DIR, ['config', 'user.email', 'seed@example.com']);
  git(WEB_BUNDLE_DIR, ['config', 'commit.gpgsign', 'false']);
  git(WEB_BUNDLE_DIR, ['add', '-A']);
  git(WEB_BUNDLE_DIR, ['commit', '-q', '-m', 'seed web fixture']);

  return WEB_BUNDLE_DIR;
}
