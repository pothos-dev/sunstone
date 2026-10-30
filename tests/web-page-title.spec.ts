import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import { WEB_BUNDLE_DIR } from './web-bundle';
import { mountShell } from './web-shell';

/**
 * The document `<title>` names the open Concept by its frontmatter `title`,
 * else by its name (the filename without `.md`), never by its H1, followed by
 * the site name (the root `index.md`'s title). Holds on the anonymous reader
 * (SSR) and in the signed-in App shell as it navigates.
 */

const SITE = ' · Web Bundle Home';

const UNTITLED = join(WEB_BUNDLE_DIR, 'untitled-note.md');

test.beforeEach(async () => {
  await writeFile(UNTITLED, '# A Heading That Is Not The Title\n\nbody\n');
});

test.afterEach(async () => {
  await rm(UNTITLED, { force: true });
});

test('the reader titles the page by frontmatter title, else the Concept name', async ({ page }) => {
  await page.goto('/good');
  await expect(page).toHaveTitle('Good Concept' + SITE);

  // The server indexes the new file through its watcher; retry until it has.
  await expect(async () => {
    await page.goto('/untitled-note');
    await expect(page).toHaveTitle('untitled-note' + SITE, { timeout: 1000 });
  }).toPass();
});

test('the App shell keeps the title on the Concept it navigates to', async ({ page }) => {
  await mountShell(page, '/good');
  await expect(page).toHaveTitle('Good Concept' + SITE);

  const tree = page.getByTestId('tree');
  await tree.locator('[data-path="critic.md"]').click();
  await expect(page).toHaveTitle('Critic Concept' + SITE);

  await expect(tree.locator('[data-path="untitled-note.md"]')).toBeVisible();
  await tree.locator('[data-path="untitled-note.md"]').click();
  await expect(page).toHaveTitle('untitled-note' + SITE);
});
