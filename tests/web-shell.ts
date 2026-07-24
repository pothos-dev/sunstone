import type { Page, Locator } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { expect } from './fixtures';
import { WEB_BUNDLE_DIR } from './web-bundle';
import { signInAsTestUser } from './web-auth';

/**
 * Shared helpers for the full-App web-shell e2e specs (branch
 * `feat/enable-web-writing`). An AUTHENTICATED web user no longer gets the
 * ticket-06 `web-edit-toggle`/`web-editor` swap — they get the WHOLE desktop
 * `App.svelte` shell mounted by `WebAppShellIsland` (`web-app-shell`). So these
 * specs drive the REAL App surface: the interactive `Tree` (`data-testid="tree"`
 * with `[data-path]` file rows), the CodeMirror buffer inside each Tile's editor
 * host (`[data-testid="editor"] .cm-content`), and the explicit-Save affordance
 * (`web-save` / `web-dirty`). Persistence is explicit-only (Cmd/Ctrl+S or the
 * Save button); blur does NOT commit on web.
 */

/** The tip commit's subject + author (name / email), from `git log -1`. */
export function headCommit(): { hash: string; subject: string; name: string; email: string } {
  const out = execFileSync(
    'git',
    ['-C', WEB_BUNDLE_DIR, 'log', '-1', '--format=%H%n%s%n%an%n%ae'],
    { encoding: 'utf8' },
  ).split('\n');
  return { hash: out[0], subject: out[1], name: out[2], email: out[3] };
}

/** Total commits reachable from HEAD (to prove NO new commit landed on blur). */
export function commitCount(): number {
  return Number(
    execFileSync('git', ['-C', WEB_BUNDLE_DIR, 'rev-list', '--count', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
  );
}

/**
 * Sign in through the real Auth.js flow, navigate to `path`, and wait for the
 * full desktop App shell to mount. `signInAsTestUser` sets the session cookie
 * but its own `goto('/')` renders the anonymous read surface (the cookie is set
 * AFTER that first render), so we re-navigate here: the SSR `load` now sees the
 * session → `data.user` → `WebViewer` flips `showApp` in `onMount` → the
 * client-only `WebAppShellIsland` mounts. `web-app-shell` only renders once the
 * lazily-imported `App.svelte` has resolved (the `web-app-loading` placeholder
 * is its `{:else}`), so waiting on it also waits out loading.
 */
export async function mountShell(page: Page, path = '/'): Promise<void> {
  await signInAsTestUser(page);
  await page.goto(path);
  await expect(page.getByTestId('web-app-shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('web-app-loading')).toHaveCount(0);
  // The anonymous SSR read surface must NOT be present for a signed-in user.
  await expect(page.getByTestId('web-viewer')).toHaveCount(0);
  // The interactive tree is server-independent App chrome; wait for it to load.
  await expect(page.getByTestId('tree')).toBeVisible({ timeout: 15_000 });
}

/** The active Tile's live CodeMirror content surface (body text; frontmatter is
 *  split into the Properties panel). */
export function cmContent(page: Page): Locator {
  return page.locator('[data-testid="editor"] .cm-content').first();
}

/**
 * Ensure the active Tile is in live-editing mode. Post-layout-rework a Concept
 * opens in `read` (the editor is NOT `contenteditable`); the per-Tile header's
 * Edit toggle (`edit-toggle`) flips the shared `session.editorMode` to `editing`
 * — the SINGLE enter-edit affordance on the App shell. The mode is global +
 * sticky (it carries across Concept switches), so this is idempotent: it clicks
 * only when the toggle is not already pressed.
 */
export async function enterEdit(page: Page): Promise<void> {
  const toggle = page.getByTestId('edit-toggle').first();
  await expect(toggle).toBeEnabled();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') {
    await toggle.click();
  }
}

/**
 * Open a Concept from the interactive App tree by clicking its `[data-path]`
 * file row, enter live-editing mode, and resolve once its CodeMirror buffer is
 * present + editable. The file must be a root-level ordinary Concept (folders
 * start collapsed).
 */
export async function openFromTree(page: Page, rel: string): Promise<Locator> {
  const entry = page.getByTestId('tree').locator(`[data-path="${rel}"]`);
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await entry.click();
  const content = cmContent(page);
  await expect(content).toBeVisible();
  // A freshly-opened Concept starts in `read`; enter editing so the buffer is
  // writable for the write/concurrency specs (see `enterEdit`).
  await enterEdit(page);
  await expect(content).toHaveAttribute('contenteditable', 'true');
  return content;
}

/** Type `text` at the end of the active CM buffer (marking it dirty). */
export async function typeAtEnd(page: Page, content: Locator, text: string): Promise<void> {
  await content.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}
