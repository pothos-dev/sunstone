import { test, expect } from '@playwright/test';

/**
 * Slice: outline-section.
 *
 * The right Sidebar gains an Outline Section above Backlinks: a live list of the
 * open Concept's markdown headings, in document order, indented by level, that
 * scrolls the editor to a heading when clicked. This drives the fake backend
 * (localStorage-backed, so a reload restores state like the real backend) to
 * assert:
 *  - the Outline lists exactly the body headings in order, indented by level,
 *  - frontmatter `#` comments and `#` lines inside fenced code blocks are NOT
 *    treated as headings (no spurious entries),
 *  - clicking an entry scrolls the editor to the correct heading line,
 *  - the "No headings" empty state renders for a Concept with no headings,
 *  - the "No Concept open" empty state renders when nothing is open, and
 *  - `outlineOpen` persists across a reload (defaults expanded).
 */

test('outline lists headings, skips frontmatter/code, scrolls on click, and persists', async ({
  page,
}) => {
  await page.goto('/');
  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Reset to a deterministic state: concepts/ + concepts/editor/ expanded (concepts/
  // now defaults COLLAPSED as it holds an index.md), everything else at defaults.
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] })));
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // The right Sidebar starts collapsed; expand it via the nav-bar toggle. We
  // assert collapsed/expanded via the aside's rendered width (the clipped inner
  // is still "visible" to Playwright), not DOM visibility.
  const rightToggle = page.getByTestId('right-sidebar-edge');
  const rightAside = page.getByTestId('right-side-bar');
  await expect(rightToggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await rightAside.boundingBox())?.width).toBe(0);
  await rightToggle.click();
  await expect(rightToggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await rightAside.boundingBox())?.width).toBeGreaterThan(0);

  // Outline defaults to expanded the moment the right Sidebar is expanded.
  const outline = page.getByTestId('outline');
  await expect(outline).toBeVisible();
  // No Concept open yet → muted empty state.
  await expect(page.getByTestId('outline-empty')).toHaveText('No Concept open');

  // --- Open a Concept with multiple headings + a frontmatter `#` + a code `#` ---
  await tree.locator('[data-path="concepts/outline-demo.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Intro prose under the top-level heading');

  // The Outline lists EXACTLY the four real headings, in document order. The
  // YAML `# this YAML comment…` line and the `# this is a shell comment…` line
  // inside the fenced code block must NOT produce entries.
  const entries = outline.getByTestId('outline-entry');
  await expect(entries).toHaveCount(4);
  await expect(entries.nth(0)).toHaveText('Outline Demo');
  await expect(entries.nth(1)).toHaveText('First Section');
  await expect(entries.nth(2)).toHaveText('A Subsection');
  await expect(entries.nth(3)).toHaveText('Second Section');

  // Indented by level: H1 (level 1) … H3 (level 3). The data-level attribute
  // carries the level and the entries step-indent (deeper = larger padding).
  await expect(entries.nth(0)).toHaveAttribute('data-level', '1');
  await expect(entries.nth(1)).toHaveAttribute('data-level', '2');
  await expect(entries.nth(2)).toHaveAttribute('data-level', '3');
  await expect(entries.nth(3)).toHaveAttribute('data-level', '2');

  const padOf = async (i: number) =>
    entries.nth(i).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  expect(await padOf(1)).toBeGreaterThan(await padOf(0));
  expect(await padOf(2)).toBeGreaterThan(await padOf(1));

  // No spurious entry from the frontmatter comment or the code-fence comment.
  await expect(outline).not.toContainText('YAML comment');
  await expect(outline).not.toContainText('shell comment');

  // --- Clicking an entry scrolls the editor to that heading's line ---
  // Read is the default; enter editing so the scroll's cursor marks an active
  // line (the active-line highlight is an editing-only extension).
  await page.getByTestId('edit-toggle').click();
  // "Second Section" is `## Second Section` on full-document line 25. The
  // scroll places the cursor at that line, marking it the active line.
  await entries.nth(3).click();
  // The scroll places the cursor on the heading line, making it the active line
  // (rendered as an h2 by the live-preview editor).
  const activeLine = editor.locator('.cm-activeLine');
  await expect(activeLine).toHaveText('Second Section');
  await expect(activeLine).toHaveClass(/cm-atomic-h2/);
  // The targeted heading line carries data-line="25" (1-based, full document).
  await expect(entries.nth(3)).toHaveAttribute('data-line', '25');

  await page.screenshot({ path: 'tests/screenshots/outline-section.png', fullPage: true });

  // --- "No headings" empty state, exercising the LIVE update ---
  // Delete the body and type heading-free prose; the Outline updates live and
  // shows the muted "No headings" empty state.
  await editor.locator('.cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type('just prose, no headings at all');
  await expect(page.getByTestId('outline-empty')).toHaveText('No headings');

  // --- outlineOpen persists across a reload (defaults expanded) ---
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('sunstone:bundleState:/fake/bundle');
        if (!raw) return null;
        return JSON.parse(raw) as { outlineOpen?: boolean };
      }),
    )
    .toMatchObject({ outlineOpen: true });

  // Collapse the Outline, let it persist, reload, and assert it stays collapsed.
  await page.getByTestId('outline-section-header').click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('sunstone:bundleState:/fake/bundle');
        if (!raw) return null;
        return JSON.parse(raw) as { outlineOpen?: boolean };
      }),
    )
    .toMatchObject({ outlineOpen: false });

  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect(page.getByTestId('right-sidebar-edge')).toHaveAttribute('aria-pressed', 'true');
  // Collapsed Outline: the header is present but its body is not rendered.
  await expect(page.getByTestId('outline-section-header')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('outline')).toHaveCount(0);
});
