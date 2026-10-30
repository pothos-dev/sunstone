import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * CriticMarkup inside GFM table cells.
 *
 * Tables render as atomic-editor's table widget, whose cells are built from
 * their own inline parser — CodeMirror decorations (where the CriticMarkup
 * rendering lives) never reach them. So the widget must render CriticMarkup
 * itself, or a cell shows the raw `{--52--}{++38++}`:
 *  - Review mode: a change confined to one cell renders as red/green marks;
 *  - reading mode: a highlight + comment authored in a cell renders as a
 *    highlight carrying its note, with the delimiters and the comment hidden.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
  };
  __sunstoneBackend: {
    fileHistory: (path: string) => Promise<unknown>;
    fileAtRev: (path: string, rev: string) => Promise<unknown>;
  };
};

const PATH = 'latency.md';
const page_ = (row: string) => `---
type: concept
title: Latency
---

# Latency

| Endpoint | Purpose | p99 |
| --- | --- | --- |
${row}
| \`GET /balances\` | Read a balance | 9 ms |
`;
const HEAD = page_('| `POST /postings` | Write a balanced posting | 52 ms |');
const WORKING = page_('| `POST /postings` | Write a balanced posting | 38 ms |');
const ANNOTATED = page_('| `POST /postings` | {==Write a balanced posting==}{>>double-entry only<<} | 52 ms |');

/** Create `PATH` with `content` in the fake bundle, giving it a HEAD of `head`, and open it. */
async function openWithHead(page: Page, content: string, head: string) {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate(
    ([path, content, head]) => {
      const w = window as unknown as FakeWindow;
      w.__sunstoneBackend.fileHistory = async (p) =>
        p === path
          ? {
              status: 'ok',
              commits: [
                { hash: 'abc1234', subject: 'Latency table', author: 'T', date: '2026-10-01T00:00:00Z', relativeDate: '4 weeks ago' },
              ],
            }
          : { status: 'untracked' };
      w.__sunstoneBackend.fileAtRev = async (p) =>
        p === path ? { status: 'ok', content: head } : { status: 'notFound' };
      w.__sunstoneFake.simulateExternalChange('created', path, content);
    },
    [PATH, content, head] as const,
  );
  await tree.locator(`[data-path="${PATH}"]`).click();
  const editor = page.getByTestId('editor');
  await expect(editor.locator('.cm-atomic-table')).toBeVisible();
  return editor;
}

test('review: a change inside a table cell renders as red/green marks, not raw markup', async ({ page }) => {
  await openWithHead(page, WORKING, HEAD);

  const toggle = page.getByTestId('review-toggle');
  await expect(toggle).toBeEnabled();
  await toggle.click();
  const review = page.getByTestId('review-editor');
  const cell = review.locator('.cm-atomic-table td', { hasText: 'ms' }).first();
  await expect(cell).toBeVisible();

  await expect(cell.locator('.cm-critic-del')).toHaveText('52');
  await expect(cell.locator('.cm-critic-add')).toHaveText('38');
  // The editor's CriticMarkup theme reaches into the widget: the marks are tinted.
  const tint = await cell
    .locator('.cm-critic-add')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(tint).not.toBe('rgba(0, 0, 0, 0)');
  // The delimiters are hidden: the cell reads as the two numbers and the unit.
  const shown = await cell.evaluate((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim());
  expect(shown).toBe('5238 ms');
});

test('reading: a highlight + comment inside a table cell renders as a highlight with its note', async ({
  page,
}) => {
  const editor = await openWithHead(page, ANNOTATED, ANNOTATED);
  const cell = editor.locator('.cm-atomic-table td', { hasText: 'balanced' });
  const highlight = cell.locator('.cm-critic-highlight');
  await expect(highlight).toHaveText('Write a balanced posting');
  await expect(highlight).toHaveAttribute('title', 'double-entry only');
  const shown = await cell.evaluate((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim());
  expect(shown).toBe('Write a balanced posting');
});
