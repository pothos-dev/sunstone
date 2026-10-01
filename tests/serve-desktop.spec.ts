import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import { SERVE_BUNDLE_DIR } from './serve-bundle';

/**
 * `sunstone serve` (ADR 0012): the desktop SPA in a plain browser, against the
 * real binary over a throwaway git repo (`playwright.serve.config.ts`).
 *
 * Proves the seam end to end: the served `index.html` selects the HTTP backend
 * (not the in-memory fake a plain browser would get), a Save reaches the disk
 * with no sign-in and lands no commit, history is read from git, an external
 * edit live-reloads, and View state is keyed by the Bundle root.
 */

const ROOT = realpathSync(SERVE_BUNDLE_DIR);

type Backend = {
  bundleRoot(): Promise<string>;
  fileHistory(path: string): Promise<{ status: string }>;
};

function commitCount(): number {
  const out = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ROOT });
  return Number(String(out).trim());
}

test('the served page runs the desktop editor on the HTTP backend', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  const root = await page.evaluate(() =>
    (window as unknown as { __sunstoneBackend: Backend }).__sunstoneBackend.bundleRoot(),
  );
  expect(root).toBe(ROOT);
  await page.getByTestId('tree').locator('[data-path="good.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('Some bold text');
});

test('a Save writes the file with no sign-in and lands no commit', async ({ page }) => {
  const before = commitCount();
  await page.goto('/');
  await page.getByTestId('tree').locator('[data-path="good.md"]').click();
  await page.getByTestId('edit-toggle').click();
  const content = page.getByTestId('editor').locator('.cm-content');
  await expect(content).toHaveAttribute('contenteditable', 'true');

  const marker = 'SERVE_AUTOSAVE_MARKER';
  await content.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(`\n\n${marker}`);

  await expect.poll(() => readFileSync(join(ROOT, 'good.md'), 'utf8')).toContain(marker);
  expect(commitCount()).toBe(before);
});

test('history is read from the git repo holding the Bundle', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  const history = await page.evaluate(() =>
    (window as unknown as { __sunstoneBackend: Backend }).__sunstoneBackend.fileHistory('index.md'),
  );
  expect(history.status).toBe('ok');
});

test('an external edit reloads the open Concept', async ({ page }) => {
  await page.goto('/');
  // A file no other spec writes: the server mutes watcher events for a path it
  // wrote itself within the last 1.5s (`SELF_WRITE_WINDOW`).
  await page.getByTestId('tree').locator('[data-path="critic.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();

  const path = join(ROOT, 'critic.md');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n\nEXTERNAL_EDIT_MARKER\n`);
  await expect(editor).toContainText('EXTERNAL_EDIT_MARKER');
});

test('View state is keyed by the Bundle root, so another Bundle never restores', async ({
  page,
}) => {
  // What a different Bundle served earlier on this same origin left behind —
  // under the web build's single key and under its own root's key.
  await page.addInitScript(() => {
    const stale = JSON.stringify({
      lastOpenConcept: 'guide/topic.md',
      expandedFolders: ['guide'],
      recentFiles: ['guide/topic.md'],
    });
    localStorage.setItem('sunstone:bundleState', stale);
    localStorage.setItem('sunstone:bundleState:/somewhere/else', stale);
  });
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect(page.getByText('Select a Concept from the tree.')).toBeVisible();

  // Opening a Concept persists under THIS root's key.
  await page.getByTestId('tree').locator('[data-path="good.md"]').click();
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as { lastOpenConcept: string | null }).lastOpenConcept : null;
      }, `sunstone:bundleState:${ROOT}`),
    )
    .toBe('good.md');
});
