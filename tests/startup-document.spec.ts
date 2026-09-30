import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * CLI DOCUMENT argument: `sunstone ./docs concepts/outline-demo.md#second-section`
 * opens that Concept into the active Tile, scrolled to the heading. The fake
 * backend stands the argument in as `?open=<path>&anchor=<slug>` (see
 * `fakeStartupDocument`).
 */

const STARTUP = '/?open=concepts/outline-demo.md&anchor=second-section';

/** True when keyboard focus sits inside the Tile's CodeMirror editor. */
function focusInEditor(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.activeElement?.closest('[data-testid="editor"] .cm-editor') != null,
  );
}

/** The Explorer row path holding keyboard focus, or null. */
function focusedTreePath(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.getAttribute('data-row-path') ?? null,
  );
}

async function expectScrolledToSecondSection(page: Page) {
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Intro prose under the top-level heading');
  // The Concept is taller than the viewport, so reaching the heading scrolls.
  await expect
    .poll(() => editor.locator('.cm-scroller').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(editor.locator('.cm-line', { hasText: 'Second Section' }).first()).toBeInViewport();
}

test('startup document opens scrolled to its anchor; read mode focuses its Explorer row', async ({
  page,
}) => {
  await page.goto(STARTUP);
  await expectScrolledToSecondSection(page);
  await expect(page.locator('[data-path="concepts/outline-demo.md"]')).toHaveClass(/selected/);
  // Read mode (the default) is not focusable, so the Explorer cursor lands on it.
  await expect.poll(() => focusedTreePath(page)).toBe('concepts/outline-demo.md');
});

test('startup document opens into the restored Tile; editing mode focuses the editor', async ({
  page,
}) => {
  // Persist a layout whose single Tile is in editing mode on another Concept.
  await page.goto('/');
  await page.getByTestId('tree').locator('[data-path="concepts/bundle.md"]').click();
  await page.getByTestId('edit-toggle').click();
  await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(700); // the session-state write is debounced

  await page.goto(STARTUP);
  await expectScrolledToSecondSection(page);
  await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => focusInEditor(page)).toBe(true);
});

test('without a startup document the Explorer keeps its initial focus', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect.poll(() => focusedTreePath(page)).not.toBeNull();
  expect(await focusInEditor(page)).toBe(false);
});
