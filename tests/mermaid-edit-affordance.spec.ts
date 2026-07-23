import { test, expect } from './fixtures';

/**
 * Slice: mermaid-edit-affordance (ADR-0005, options 6a+6b).
 *
 * A `block: true` replace decoration swallows its source, so there is no text to
 * click into. The widget therefore carries (editing only):
 *  - a hover affordance: `cursor: pointer` + a subtle "✎ edit" hint, and
 *  - a double-click handler that dispatches a selection INTO the fence range,
 *    lifting the block-replace to reveal the raw source for editing.
 * Read mode (the default) never lifts the block-replace, so the affordance is
 * absent there.
 */

// The editor mode is now persisted per-Bundle (persist-editor-mode). Under the
// shared-CDP-browser sandbox run localStorage survives across tests, so a prior
// test's Editing choice would bleed in here; clear it so every test boots from
// the read default. On CI each test already gets an isolated context (no-op).
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] })));
});

test('mermaid: clicking a diagram reveals the raw fence for editing', async ({
  page,
}) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();

  // Enter live editing (read is the default; the edit affordance is editing-only).
  await page.getByTestId('edit-toggle').click();
  await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'true');

  await editor.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  const widget = editor.locator('.cm-mermaid');
  const diagram = widget.locator('svg');
  await expect(diagram).toBeVisible({ timeout: 15000 });

  // Hover affordance: the widget is marked editable (pointer cursor) while editing
  // and carries the edit hint.
  await expect(widget).toHaveClass(/cm-mermaid-editable/);
  await expect(widget).toHaveCSS('cursor', 'pointer');
  await expect(widget.locator('.cm-mermaid-edit-hint')).toHaveCount(1);

  // Click the rendered diagram: the block-replace has no source text to click
  // into, so the click lands the caret at the fence boundary (which
  // `selectionTouches` treats as inside), lifting the replace and revealing the
  // raw `graph TD` source for editing. (A single click already reveals — it
  // reflows the widget away — so the double-click affordance can't add a second
  // reveal; the hover hint above is the discoverability cue.)
  await diagram.click();
  await expect(editor).toContainText('graph TD');

  await page.screenshot({
    path: 'tests/screenshots/mermaid-edit-affordance.png',
    fullPage: true,
  });
});

/**
 * Read mode is read-only and never lifts the block-replace, so the edit
 * affordance must be absent — including after toggling editing OFF, where the
 * mode Compartment reconfigures in place and the widget's DOM could otherwise be
 * reused (widget `eq()` must account for `reading`).
 */
test('mermaid: read mode drops the edit affordance after toggling editing off', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();

  // Enter editing first so the assertions below prove the affordance was actively
  // DROPPED by toggling read, not merely never added.
  await page.getByTestId('edit-toggle').click();

  await editor.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  const widget = editor.locator('.cm-mermaid');
  await expect(widget.locator('svg')).toBeVisible({ timeout: 15000 });
  await expect(widget).toHaveClass(/cm-mermaid-editable/);
  await expect(widget.locator('.cm-mermaid-edit-hint')).toHaveCount(1);

  // Toggle editing OFF (read): the diagram still renders, but the affordance is
  // gone — no editable marker, no hover hint, no "double-click to edit" tooltip.
  await page.getByTestId('edit-toggle').click();
  await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(widget.locator('svg')).toBeVisible();
  await expect(widget).not.toHaveClass(/cm-mermaid-editable/);
  await expect(widget.locator('.cm-mermaid-edit-hint')).toHaveCount(0);
  await expect(widget).not.toHaveAttribute('title', /edit/i);

  // And double-clicking does NOT reveal the raw fence (read-only).
  await widget.locator('svg').dblclick();
  await expect(editor).not.toContainText('graph TD');
});
