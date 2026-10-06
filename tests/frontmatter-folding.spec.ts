import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * ov-15: fold blocks in the Frontmatter YAML editor.
 *
 * Top-level `sources` / `verified` start folded behind a placeholder that says
 * what is inside; clicking it unfolds; opening another Concept folds again;
 * folding never changes the file. Driven against the fake backend.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

const concept = (title: string) =>
  [
    '---',
    'type: Note',
    `title: ${title}`,
    'sources:',
    '  - id: a',
    `    resource: https://a.example/${title}`,
    '  - id: b',
    '    resource: https://b.example',
    'verified:',
    '  - { by: human:d, at: 2026-10-06T00:00:00Z }',
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');

async function create(page: Page, path: string, content: string) {
  await page.evaluate(
    ([p, c]) => (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('created', p, c),
    [path, content] as const,
  );
}

async function setup(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await create(page, 'one.md', concept('one'));
  await create(page, 'two.md', concept('two'));
  await page.locator('[data-path="one.md"]').click();
  await page.getByTestId('frontmatter-toggle').click();
  return page.getByTestId('frontmatter');
}

test('sources and verified start folded behind a summary', async ({ page }) => {
  const fm = await setup(page);
  const folds = fm.getByTestId('frontmatter-fold');
  await expect(folds).toHaveCount(2);
  await expect(folds.nth(0)).toHaveText('2 entries');
  await expect(folds.nth(1)).toHaveText('1 entry');
  await expect(fm).toContainText('title: one');
  await expect(fm).not.toContainText('https://a.example/one');
});

test('clicking the summary unfolds without touching the file', async ({ page }) => {
  const fm = await setup(page);
  const before = await page.evaluate(() => (window as unknown as FakeWindow).__sunstoneFake.files['one.md']);
  await fm.getByTestId('frontmatter-fold').first().click();
  await expect(fm).toContainText('https://a.example/one');
  await expect(fm.getByTestId('frontmatter-fold')).toHaveCount(1);
  const after = await page.evaluate(() => (window as unknown as FakeWindow).__sunstoneFake.files['one.md']);
  expect(after).toBe(before);
});

test('opening another Concept folds its lists again', async ({ page }) => {
  const fm = await setup(page);
  await fm.getByTestId('frontmatter-fold').first().click();
  await expect(fm).toContainText('https://a.example/one');

  await page.locator('[data-path="two.md"]').click();
  await expect(fm).toContainText('title: two');
  await expect(fm.getByTestId('frontmatter-fold')).toHaveCount(2);
  await expect(fm).not.toContainText('https://a.example/two');
});
