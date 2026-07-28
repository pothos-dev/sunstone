import { test, expect } from '@playwright/test';

/**
 * Slice: outline-active-heading.
 *
 * The Outline highlights the Current heading — the last heading at or above a
 * probe ~50px below the editor viewport's top, i.e. the resting spot an Outline
 * click scrolls a heading to. This asserts:
 *  - opening a Concept marks its first heading Current (top of the document),
 *  - clicking an entry makes THAT entry Current (the click scrolls the heading to
 *    the probe), and
 *  - scrolling the editor back to the top walks the highlight back up.
 */
test('the Outline marks the heading whose section is being read', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  await page.evaluate(() =>
    window.localStorage.setItem(
      'sunstone:bundleState:/fake/bundle',
      JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] }),
    ),
  );
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();

  await page.getByTestId('right-sidebar-edge').click();
  await page.getByTestId('tree').locator('[data-path="concepts/outline-demo.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Intro prose under the top-level heading');

  const entries = page.getByTestId('outline').getByTestId('outline-entry');
  await expect(entries).toHaveCount(4);
  const current = page.getByTestId('outline').locator('[data-current="true"]');

  // At the top of the document the H1 is the Current heading.
  await expect(current).toHaveText('Outline Demo');

  // Clicking an entry scrolls that heading to the probe → it becomes Current.
  await entries.nth(3).click();
  await expect(current).toHaveText('Second Section');
  await expect(entries.nth(3)).toHaveAttribute('aria-current', 'true');
  await expect(entries.nth(0)).not.toHaveAttribute('data-current', 'true');

  await page.screenshot({ path: 'tests/screenshots/outline-active-heading.png', fullPage: true });

  // Natural scrolling drives it too: scroll the editor back to the top.
  await editor.locator('.cm-scroller').evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(current).toHaveText('Outline Demo');
});
