import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: outline-backlinks-keyboard-nav.
 *
 * Keyboard navigation for the two read-only list Regions in the right Sidebar —
 * Outline and Backlinks. Both are flat, navigate-and-open lists with a roving
 * tabindex (exactly one item `tabindex="0"`, the rest `-1`), a Focused-item ring,
 * `↑/↓/j/k` movement that CLAMPS at the ends, and a per-Region `Enter`:
 *   - Outline `Enter` scrolls the Editor to the heading AND focuses the Editor;
 *   - Backlinks `Enter` opens the linked Concept (focus → Editor).
 *
 * Mouse clicks must keep working. Cross-Region movement (Alt+dir) + Escape stay
 * with the global handler and are not re-tested here.
 */

/** Expand the right Sidebar (idempotent) so Outline + Backlinks are interactable. */
async function expandRightSidebar(page: Page) {
  const toggle = page.getByTestId('right-sidebar-edge');
  if ((await toggle.getAttribute('aria-pressed')) === 'false') await toggle.click();
}

/** The `data-index` of the entry that currently holds DOM focus, or null. */
async function focusedIndex(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement ? (el.getAttribute('data-index') ?? null) : null;
  });
}

/** Count of tab-focusable entries (`tabindex="0"`) within a testid'd list — must be 1. */
async function rovingCount(page: Page, testid: string): Promise<number> {
  return page.evaluate(
    (t) => document.querySelectorAll(`[data-testid="${t}"][tabindex="0"]`).length,
    testid,
  );
}

/** Is DOM focus currently inside the CodeMirror editor? */
function inEditor(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return !!el && !!el.closest('.cm-editor');
  });
}

async function freshLoad(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] })));
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
}

test('Outline keyboard nav: arrow/jk move + clamp, roving tabindex, Enter scrolls + focuses Editor', async ({
  page,
}) => {
  await freshLoad(page);
  await expandRightSidebar(page);

  // Open a Concept with several headings so arrowing has somewhere to go.
  await page.getByTestId('tree').locator('[data-path="concepts/outline-demo.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Intro prose under the top-level heading');

  const outline = page.getByTestId('outline');
  const entries = outline.getByTestId('outline-entry');
  await expect(entries).toHaveCount(4);

  // Click the first entry to enter the Region: it becomes the Focused item (the
  // roving tabindex) without arrowing yet. (Clicking also scrolls — fine.)
  await entries.nth(0).click();
  await expect.poll(() => focusedIndex(page)).toBe('0');
  await expect.poll(() => rovingCount(page, 'outline-entry')).toBe(1);

  // ArrowUp at the first entry CLAMPS (no wrap).
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusedIndex(page)).toBe('0');

  // ArrowDown / j move the Focused item down.
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedIndex(page)).toBe('1');
  await page.keyboard.press('j');
  await expect.poll(() => focusedIndex(page)).toBe('2');

  // k moves back up.
  await page.keyboard.press('k');
  await expect.poll(() => focusedIndex(page)).toBe('1');

  // End jumps to the last entry; ArrowDown there CLAMPS (no wrap).
  await page.keyboard.press('End');
  await expect.poll(() => focusedIndex(page)).toBe('3');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedIndex(page)).toBe('3');

  // The roving-tabindex invariant holds throughout: exactly one focusable entry.
  await expect.poll(() => rovingCount(page, 'outline-entry')).toBe(1);

  // Enter on the last entry ("Second Section") scrolls the Editor to that
  // heading AND moves focus to the Editor.
  await page.keyboard.press('Enter');
  const activeLine = editor.locator('.cm-activeLine');
  await expect(activeLine).toHaveText('Second Section');
  await expect.poll(() => inEditor(page)).toBe(true);

  await page.screenshot({ path: 'tests/screenshots/outline-backlinks-keyboard-nav.png', fullPage: true });
});

test('Backlinks keyboard nav: arrow/jk move + clamp, roving tabindex, Enter opens the linked Concept (focus → Editor)', async ({
  page,
}) => {
  await freshLoad(page);
  await expandRightSidebar(page);

  // Open a Concept several others link TO, so the Backlinks list is non-trivial.
  await page.getByTestId('tree').locator('[data-path="concepts/codemirror.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  const backlinks = page.getByTestId('backlinks');
  const entries = backlinks.getByTestId('backlink');
  await expect(entries).toHaveCount(4);

  // Enter the Backlinks Region from the Editor via Alt-movement (clicking a
  // backlink would open+navigate instead of just focusing). Focus the editor,
  // then Alt+Right lands on the right column's Backlinks Region. The first
  // ArrowDown then makes entry 0 the Focused item (from a null start).
  await editor.locator('.cm-content').click();
  await expect.poll(() => inEditor(page)).toBe(true);
  // Editor is col1,row1; the right column's same-row (row1) Region is Backlinks,
  // so a single Alt+Right lands there (Outline is row0).
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('.region-active[data-region="backlinks"]')).toBeVisible();

  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedIndex(page)).toBe('0');
  await expect.poll(() => rovingCount(page, 'backlink')).toBe(1);

  // ArrowUp at the first entry CLAMPS (no wrap).
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusedIndex(page)).toBe('0');

  // ArrowDown / j move down; k moves back up.
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedIndex(page)).toBe('1');
  await page.keyboard.press('j');
  await expect.poll(() => focusedIndex(page)).toBe('2');
  await page.keyboard.press('k');
  await expect.poll(() => focusedIndex(page)).toBe('1');

  // End → last; ArrowDown there CLAMPS.
  await page.keyboard.press('End');
  await expect.poll(() => focusedIndex(page)).toBe('3');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedIndex(page)).toBe('3');
  await expect.poll(() => rovingCount(page, 'backlink')).toBe(1);

  // Home → first, then Enter opens that linked Concept and moves focus to the
  // Editor. Record which source the first entry points at to assert it opened.
  await page.keyboard.press('Home');
  await expect.poll(() => focusedIndex(page)).toBe('0');
  const firstSource = await entries.nth(0).getAttribute('data-path');
  expect(firstSource).not.toBeNull();

  await page.keyboard.press('Enter');
  await expect.poll(() => inEditor(page)).toBe(true);
  // The opened Concept is no longer codemirror.md (we navigated to a backlink).
  await expect(editor).not.toContainText('CodeMirror 6 is the editor core');
});

test('mouse click still works in both Regions', async ({ page }) => {
  await freshLoad(page);
  await expandRightSidebar(page);

  // Outline: clicking an entry scrolls the Editor to its heading.
  await page.getByTestId('tree').locator('[data-path="concepts/outline-demo.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Intro prose under the top-level heading');
  const outlineEntries = page.getByTestId('outline').getByTestId('outline-entry');
  await outlineEntries.nth(3).click();
  await expect(editor.locator('.cm-activeLine')).toHaveText('Second Section');

  // Backlinks: clicking an entry opens that source Concept.
  await page.getByTestId('tree').locator('[data-path="concepts/codemirror.md"]').click();
  await expect(editor).toContainText('CodeMirror 6 is the editor core');
  const backlinks = page.getByTestId('backlinks');
  await backlinks.locator('[data-path="concepts/bundle.md"]').click();
  await expect(editor).toContainText('A Bundle is the root folder');
});
