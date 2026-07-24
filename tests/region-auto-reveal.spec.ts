import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: transient-region-auto-reveal.
 *
 * Replaces "skip ALL hidden Regions" with transient AUTO-REVEAL for Regions
 * hidden only by a collapse, while still SKIPPING genuinely absent/empty ones:
 *
 *   - Alt+dir toward a collapse-hidden Sidebar/Section transiently reveals it
 *     and lands focus inside.
 *   - Leaving the Region re-collapses it — UNLESS it was manually expanded
 *     before the visit (no in-visit pin).
 *   - A peek survives an overlay (QuickNav) open/cancel round-trip.
 *   - Absent (no Concept → Properties) and empty (no tags → Tags) Regions stay
 *     SKIPPED, never revealed.
 *
 *        col 0 (left)   col 1 (editor)   col 2 (right)
 *   row0  Explorer       Properties       Outline
 *   row1  Tags           Editor           Backlinks
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

async function altPress(page: Page, key: string) {
  await page.keyboard.press(`Alt+${key}`);
}

/** Open a Concept with headings + backlinks so the right-Sidebar Regions have
 *  content, from a clean fresh-Bundle state. Leaves focus in the Editor. */
async function openConcept(page: Page) {
  await page.goto('/');
  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] })));
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');
  // Read is the default; enter editing so the Editor Region is focusable.
  await page.getByTestId('edit-toggle').click();
  await editor.locator('.cm-content').click();
  await expectActive(page, 'editor');
}

test('collapse-hidden Section is transiently revealed on Alt-in and re-collapses on leave', async ({
  page,
}) => {
  await openConcept(page);

  // The right Sidebar starts COLLAPSED (fresh default), so its Regions are
  // hidden purely by a collapse — present (a Concept is open) but not shown.
  await expect(page.getByTestId('right-side-bar')).toHaveClass(/collapsed/);

  // Alt+Right toward the right column: previously this CLAMPED (hidden skipped);
  // now it transiently reveals the right Sidebar and lands focus in Backlinks
  // (the same-row partner of the Editor — see the grid above).
  await altPress(page, 'ArrowRight');
  await expectActive(page, 'backlinks');
  await expect(page.getByTestId('right-side-bar')).not.toHaveClass(/collapsed/);
  // Focus is actually INSIDE the revealed Region (a focusable descendant).
  expect(
    await page.evaluate(() => {
      const region = document.querySelector('[data-region="backlinks"]');
      return region?.contains(document.activeElement) ?? false;
    }),
  ).toBe(true);

  await page.screenshot({
    path: 'tests/screenshots/region-auto-reveal.png',
    fullPage: true,
  });

  // Leave the Region (Escape → Editor). The peek was NOT manually expanded
  // beforehand, so it snaps back: the right Sidebar re-collapses.
  await page.keyboard.press('Escape');
  await expectActive(page, 'editor');
  await expect(page.getByTestId('right-side-bar')).toHaveClass(/collapsed/);
});

test('a manually-expanded Section stays open after focus leaves', async ({ page }) => {
  await openConcept(page);

  // Manually expand the right Sidebar (the persisted `expanded` state). Outline
  // + Backlinks Sections default to open within it.
  await page.getByTestId('right-sidebar-edge').click();
  await expect(page.getByTestId('right-side-bar')).not.toHaveClass(/collapsed/);
  await expect(page.getByTestId('backlinks')).toBeVisible();

  // Clicking the toggle moved focus out of the Editor Region; re-establish it.
  await page.getByTestId('editor').locator('.cm-content').click();
  await expectActive(page, 'editor');

  // Alt+Right into Backlinks (already shown — no reveal needed), then leave.
  await altPress(page, 'ArrowRight');
  await expectActive(page, 'backlinks');
  await page.keyboard.press('Escape');
  await expectActive(page, 'editor');

  // It was manually expanded BEFORE the visit, so it STAYS open (no re-collapse).
  await expect(page.getByTestId('right-side-bar')).not.toHaveClass(/collapsed/);
  await expect(page.getByTestId('backlinks')).toBeVisible();
});

test('a peeked Region survives an overlay (QuickNav) open/cancel round-trip', async ({
  page,
}) => {
  await openConcept(page);
  await expect(page.getByTestId('right-side-bar')).toHaveClass(/collapsed/);

  // Peek the right Sidebar (transient reveal lands focus in Backlinks).
  await altPress(page, 'ArrowRight');
  await expectActive(page, 'backlinks');
  await expect(page.getByTestId('right-side-bar')).not.toHaveClass(/collapsed/);

  // Open QuickNav (Ctrl+K) — focus leaves the Region for an overlay OUTSIDE every
  // Region, so the peek must NOT collapse while the overlay is up.
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('quick-nav')).toBeVisible();
  await expect(page.getByTestId('right-side-bar')).not.toHaveClass(/collapsed/);

  // Cancel the overlay (Escape closes QuickNav). The right Sidebar is still
  // revealed: focus never landed in a DIFFERENT Region, so nothing cleared.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-nav')).toHaveCount(0);
  await expect(page.getByTestId('right-side-bar')).not.toHaveClass(/collapsed/);
});

test('absent (no Concept → Properties/Editor) and empty (no tags → Tags) Regions are skipped, not revealed', async ({
  page,
}) => {
  // Fresh load with NO Concept open: the centre column (Properties + Editor) is
  // ABSENT, and the right column (Outline + Backlinks) is absent too.
  await page.goto('/');
  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] })));
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Focus the Explorer (left column) WITHOUT opening a Concept.
  await page.getByTestId('explorer-section-body').locator('.row').first().focus();
  await expectActive(page, 'explorer');

  // Alt+Right: Properties/Editor are absent (no Concept) and so is the right
  // column → movement CLAMPS, no Region is revealed (the right Sidebar stays
  // collapsed; nothing in the centre appears).
  await altPress(page, 'ArrowRight');
  await expectActive(page, 'explorer');
  await expect(page.getByTestId('right-side-bar')).toHaveClass(/collapsed/);

  // Now make the Tags Section EMPTY (strip every Concept's tags) — it unmounts.
  await page.evaluate(() => {
    (window as unknown as { __sunstoneFake: { clearAllTags: () => void } }).__sunstoneFake.clearAllTags();
  });
  await expect(page.getByTestId('tags-section')).toHaveCount(0);

  // From the Explorer, Alt+Down toward Tags: it is now absent/empty → SKIP, the
  // move clamps (Explorer is the only present Region in the left column) and the
  // empty Tags Section is NOT revealed (it never reappears).
  await expectActive(page, 'explorer');
  await altPress(page, 'ArrowDown');
  await expectActive(page, 'explorer');
  await expect(page.getByTestId('tags-section')).toHaveCount(0);
});

test('Properties hidden by the global toggle is ABSENT: Alt-in clamps, nothing revealed', async ({
  page,
}) => {
  await openConcept(page);

  // Properties is HIDDEN by default now (global toggle), so the centre-column
  // Properties Region is genuinely ABSENT — like an empty Region, it is skipped,
  // never revealed. Alt+Up from the Editor (row1) has no row0 target in the
  // column, so it clamps and focus stays in the Editor.
  await expect(page.getByTestId('properties')).toHaveCount(0);
  await altPress(page, 'ArrowUp');
  await expectActive(page, 'editor');
  await expect(page.getByTestId('properties')).toHaveCount(0);
});

test('Properties shown by the global toggle: Alt-in lands focus, Escape returns, stays shown', async ({
  page,
}) => {
  await openConcept(page);

  // Turn Properties ON globally — its panel renders inline in the tile and the
  // 'properties' Region becomes present + visible. Re-focus the Editor after the
  // toggle click so the next Alt+Up is a real cross-Region move.
  await page.getByTestId('properties-toggle').click();
  await expect(page.getByTestId('properties')).toBeVisible();
  await page.getByTestId('editor').locator('.cm-content').click();
  await expectActive(page, 'editor');

  // Alt+Up toward Properties (row0, col1): present + visible → focus lands in the
  // grid, no transient reveal needed (the global toggle is the only show/hide).
  await altPress(page, 'ArrowUp');
  await expectActive(page, 'properties');
  await expect(page.getByTestId('scalar-type')).toBeVisible();
  expect(
    await page.evaluate(() => {
      const region = document.querySelector('[data-region="properties"]');
      return region?.contains(document.activeElement) ?? false;
    }),
  ).toBe(true);

  // Leave the Region (Escape → Editor). Properties is globally shown, not a
  // transient peek, so it STAYS shown.
  await page.keyboard.press('Escape');
  await expectActive(page, 'editor');
  await expect(page.getByTestId('properties')).toBeVisible();
});

test('Section-collapsed Tags (left Sidebar open) is transiently revealed on Alt-Down from the Explorer', async ({
  page,
}) => {
  // Fresh load: the left Sidebar is open and the Bundle carries tags, so the
  // Tags Section is PRESENT but COLLAPSED by default (its per-field default) —
  // its body content is unmounted while the header stays.
  await page.goto('/');
  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] })));
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  const tagsToggle = page.getByTestId('tags-section').locator('[aria-expanded]').first();
  await expect(tagsToggle).toHaveAttribute('aria-expanded', 'false');
  // Collapsed Section: the panel content is gone, but the Section is still present.
  await expect(page.getByTestId('tag-browser')).toHaveCount(0);

  // Focus the Explorer, then Alt+Down toward Tags. Previously this CLAMPED (the
  // collapsed body had unmounted the Region, so it was unreachable); now the
  // Section is transiently revealed and focus lands inside it.
  await page.getByTestId('explorer-section-body').locator('.row').first().focus();
  await expectActive(page, 'explorer');
  await altPress(page, 'ArrowDown');

  await expectActive(page, 'tags');
  await expect(tagsToggle).toHaveAttribute('aria-expanded', 'true');
  expect(
    await page.evaluate(() => {
      const region = document.querySelector('[data-region="tags"]');
      return region?.contains(document.activeElement) ?? false;
    }),
  ).toBe(true);

  // Leave the Region (Escape → Editor home base is absent with no Concept, so
  // Escape peels back to the Explorer): the transient peek snaps back, the Tags
  // Section re-collapses.
  await page.getByTestId('explorer-section-body').locator('.row').first().focus();
  await expectActive(page, 'explorer');
  await expect(tagsToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('tag-browser')).toHaveCount(0);
});
