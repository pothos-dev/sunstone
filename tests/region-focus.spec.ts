import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: region-focus-backbone.
 *
 * The keyboard-focus backbone: an active Region (mirrored from DOM focus) and
 * directional movement across the 3×2 Region grid
 *
 *        col 0 (left)   col 1 (editor)   col 2 (right)
 *   row0  Explorer       Properties       Outline
 *   row1  Tags           Editor           Backlinks
 *
 * Drives Alt-movement (arrows + hjkl) across the visible Regions, asserts the
 * active-Region highlight tracks focus, asserts sticky per-column landing and
 * per-Region item memory, asserts hidden Regions are skipped, and asserts
 * Escape returns focus to the Editor. Also checks the history rebind
 * (Ctrl+Alt+arrows) and that Ctrl+C/Ctrl+V are never swallowed.
 */

/** The id of the Region currently showing the active-Region affordance. */
async function activeRegion(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.region-active[data-region]');
    return el ? el.getAttribute('data-region') : null;
  });
}

async function expectActive(page: Page, id: string) {
  await expect.poll(() => activeRegion(page)).toBe(id);
}

/** Press an Alt-chord (e.g. 'ArrowLeft', 'k'). */
async function altPress(page: Page, key: string) {
  await page.keyboard.press(`Alt+${key}`);
}

test('Region focus: directional movement, sticky landing, Escape→Editor', async ({ page }) => {
  await page.goto('/');
  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Reset to a deterministic state: concepts/ + concepts/editor/ expanded (concepts/
  // now defaults COLLAPSED as it holds an index.md), everything else at defaults.
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'], propertiesShown: true })));
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Open a Concept that has frontmatter (Properties), headings (Outline) and
  // backlinks (Backlinks), so all six Regions can be populated.
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Reveal the right Sidebar so Outline + Backlinks Regions become visible.
  await page.getByTestId('right-sidebar-edge').click();
  await expect(page.getByTestId('outline')).toBeVisible();
  await expect(page.getByTestId('backlinks')).toBeVisible();

  // Establish a known baseline: focus the Editor (home base). This also seeds
  // the editor column's sticky memory with the Editor.
  await editor.locator('.cm-content').click();
  await expectActive(page, 'editor');

  // Alt+Left → left column. Its sticky memory is the Explorer (focused when the
  // Concept was opened from the tree during setup), so we land there.
  await altPress(page, 'ArrowLeft');
  await expectActive(page, 'explorer');

  // Alt+Up clamps at the top edge (no wrap) — still Explorer (col0,row0).
  await altPress(page, 'ArrowUp');
  await expectActive(page, 'explorer');

  // Alt+Down (within the left column) → Tags (col0,row1).
  await altPress(page, 'ArrowDown');
  await expectActive(page, 'tags');

  // Alt+Down clamps at the bottom edge (no wrap) — still Tags.
  await altPress(page, 'ArrowDown');
  await expectActive(page, 'tags');

  // Alt+l (hjkl right) → editor column. The column's memory is the Editor
  // (row1), so sticky landing returns to the Editor (NOT same-row Properties).
  await altPress(page, 'l');
  await expectActive(page, 'editor');

  // Alt+k (up) within the editor column → Properties (col1,row0).
  await altPress(page, 'k');
  await expectActive(page, 'properties');

  // Alt+l → right column. Same-row (row0) → Outline (no right-column memory yet).
  await altPress(page, 'l');
  await expectActive(page, 'outline');

  // Alt+Right clamps at the rightmost column — still Outline.
  await altPress(page, 'ArrowRight');
  await expectActive(page, 'outline');

  // Alt+j (down) within the right column → Backlinks (col2,row1).
  await altPress(page, 'j');
  await expectActive(page, 'backlinks');

  // Escape from a non-Editor Region returns focus to the Editor.
  await page.keyboard.press('Escape');
  await expectActive(page, 'editor');

  // Sticky per-column landing: the right column's last-used Region was Backlinks.
  // From the Editor, Alt+Right returns to Backlinks, NOT the same-row Outline.
  await altPress(page, 'ArrowRight');
  await expectActive(page, 'backlinks');

  // Sticky per-Region item memory: focus a specific Backlinks entry, leave, and
  // return — the same item regains focus.
  const firstBacklink = page.getByTestId('backlink').first();
  await firstBacklink.focus();
  await expect(firstBacklink).toBeFocused();
  // Leave to the Editor, then return to the right column.
  await page.keyboard.press('Escape');
  await expectActive(page, 'editor');
  await altPress(page, 'ArrowRight');
  // The right column's memory is Backlinks, and within it the remembered item is
  // the focused entry.
  await expectActive(page, 'backlinks');
  await expect(firstBacklink).toBeFocused();

  await page.screenshot({ path: 'tests/screenshots/region-focus.png', fullPage: true });
});

test('absent Regions are skipped; movement clamps at grid edges', async ({ page }) => {
  // NOTE: collapse-hidden Regions are now transiently REVEALED, not skipped
  // (slice: transient-region-auto-reveal — see region-auto-reveal.spec.ts). The
  // skip/clamp behaviour now applies only to GENUINELY ABSENT Regions (nothing
  // to focus). With NO Concept open, the centre column (Properties + Editor) and
  // the right column (Outline + Backlinks) are all absent.
  await page.goto('/');
  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'], propertiesShown: true })));
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Focus the Explorer (left column) WITHOUT opening a Concept.
  await tree.locator('.row').first().focus();
  await expectActive(page, 'explorer');

  // From the Explorer, Alt+Right should CLAMP: every column to the right has no
  // present Region (no Concept open), and nothing is revealed.
  await altPress(page, 'ArrowRight');
  await expectActive(page, 'explorer'); // clamped — no present Region to the right
  await expect(page.getByTestId('right-side-bar')).toHaveClass(/collapsed/);
});

test('history is on Ctrl+Alt+arrows; plain Alt+arrows no longer navigates; copy/paste untouched', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'], propertiesShown: true })));
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  const editor = page.getByTestId('editor');

  // Build a 2-entry history: open Bundle, then CodeMirror.
  await tree.locator('[data-path="concepts/bundle.md"]').click();
  await expect(editor).toContainText('A Bundle is the root folder');
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Plain Alt+Left must NOT navigate history (it is Region movement now). Focus
  // the editor first so Alt+Left would have triggered a Back before the rebind.
  await editor.locator('.cm-content').click();
  await expectActive(page, 'editor');
  await altPress(page, 'ArrowLeft');
  // Still showing CodeMirror (no Back happened); focus moved to a left Region.
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Ctrl+Alt+Left navigates Back (history rebind).
  await page.keyboard.press('Control+Alt+ArrowLeft');
  await expect(editor).toContainText('A Bundle is the root folder');
  // Ctrl+Alt+Right navigates Forward.
  await page.keyboard.press('Control+Alt+ArrowRight');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Ctrl+C / Ctrl+V are never intercepted by the global handler: with focus in
  // the editor, a Ctrl+V paste still reaches CodeMirror and inserts text.
  await editor.locator('.cm-content').click();
  await page.evaluate(() => navigator.clipboard?.writeText?.('PASTED_SENTINEL'));
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+v');
  await expect(editor).toContainText('PASTED_SENTINEL');
});
