import { test, expect } from './fixtures';

/** Expand a collapsible sidebar Section if it is currently collapsed (idempotent). */
async function expandSection(page: import('@playwright/test').Page, name: string) {
  const header = page.getByTestId(`${name}-section-header`);
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
}

/**
 * Slice 8: tag browser.
 *
 * Drives the right-hand Tag browser against the fake backend:
 *  - asserts tags are listed with per-tag counts (the fixture shares `okf`
 *    across several Concepts and `editor` across two);
 *  - selects a tag and asserts the matching Concepts are revealed;
 *  - opens a Concept from the filtered list (through navigation history);
 *  - confirms the tag list reflects a frontmatter edit on disk without restart.
 */
test('tag browser lists tags with counts, filters, and opens Concepts', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  // Tags is a collapsed-by-default sidebar Section; expand to read it.
  await expandSection(page, 'tags');
  const tagBrowser = page.getByTestId('tag-browser');
  await expect(tagBrowser).toBeVisible();

  // Tags are listed with counts. `okf` is on several Concepts; `editor` on two.
  const okf = tagBrowser.locator('[data-tag="okf"]');
  await expect(okf).toBeVisible();
  await expect(okf.getByTestId('tag-count')).toHaveText('5');

  const editorTag = tagBrowser.locator('[data-tag="editor"]');
  await expect(editorTag.getByTestId('tag-count')).toHaveText('2');

  // Selecting a tag reveals the Concepts carrying it.
  await editorTag.click();
  const concepts = tagBrowser.getByTestId('tag-concept');
  await expect(concepts).toHaveCount(2);
  await expect(tagBrowser.locator('[data-path="concepts/codemirror.md"]')).toBeVisible();
  await expect(
    tagBrowser.locator('[data-path="concepts/editor/live-preview.md"]'),
  ).toBeVisible();

  await page.screenshot({ path: 'tests/screenshots/tag-browser.png', fullPage: true });

  // Selecting a Concept from the filtered list opens it (through navigation).
  const editor = page.getByTestId('editor');
  await tagBrowser.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // It participates in history: Back is now enabled and returns to nothing-open.
  await expect(page.getByTestId('nav-back')).toBeDisabled();
});

test('tag browser reflects frontmatter tag edits on disk', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  await expandSection(page, 'tags');
  const tagBrowser = page.getByTestId('tag-browser');

  // A brand-new tag does not exist yet.
  await expect(tagBrowser.locator('[data-tag="freshtag"]')).toHaveCount(0);

  // Simulate another tool adding `freshtag` to a Concept's frontmatter.
  await page.evaluate(() => {
    const fake = (
      window as unknown as {
        __sunstoneFake: {
          simulateExternalChange: (kind: string, path: string, content?: string) => void;
          files: Record<string, string>;
        };
      }
    ).__sunstoneFake;
    const original = fake.files['concepts/bundle.md'];
    const updated = original.replace('tags: [okf, core]', 'tags: [okf, core, freshtag]');
    fake.simulateExternalChange('modified', 'concepts/bundle.md', updated);
  });

  // The tag list reflects the edit (index version bump) without a restart.
  const fresh = tagBrowser.locator('[data-tag="freshtag"]');
  await expect(fresh).toBeVisible();
  await expect(fresh.getByTestId('tag-count')).toHaveText('1');

  // And it filters to the Concept that now carries it.
  await fresh.click();
  await expect(tagBrowser.locator('[data-path="concepts/bundle.md"]')).toBeVisible();
});
