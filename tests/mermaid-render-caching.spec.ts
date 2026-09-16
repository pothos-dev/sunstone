import { test, expect } from './fixtures';

/**
 * Slice: mermaid-render-caching (ADR-0005, option 9a).
 *
 * The field rebuilds its decoration set on every doc change — including edits
 * BETWEEN diagrams — and `mermaid.render()` is async. `WidgetType.eq()` keyed on
 * `(source + theme)` lets CM6 reuse the existing widget DOM, so an unrelated edit
 * neither rebuilds nor re-renders the diagram. We assert the rendered SVG keeps
 * its render id (each `mermaid.render()` uses a fresh id) across an edit that
 * leaves the diagram source untouched.
 *
 * (The pure cache-key/identity and generation-token logic is unit-tested in
 * `mermaidBlocks.test.ts`; this is the in-browser DOM-reuse observation.)
 */
test('mermaid: editing text outside a diagram does not re-render it', async ({
  page,
}) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();

  await editor.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  const diagram = editor.locator('.cm-mermaid svg');
  await expect(diagram).toBeVisible({ timeout: 15000 });

  // The render id baked onto the rendered SVG (fresh per `mermaid.render`).
  const before = await diagram.getAttribute('id');
  expect(before).toBeTruthy();

  // Edit text OUTSIDE the diagram: place the caret at the very top of the doc
  // and type. The fence source is unchanged, so the widget's `eq()` holds and
  // CM6 reuses the existing SVG DOM (no re-render).
  await editor.locator('.cm-content').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('Edited prose. ');

  // Give any (unwanted) re-render a chance to swap the SVG, then assert the id
  // is unchanged — the diagram DOM was reused, not re-rendered.
  await page.waitForTimeout(500);
  // `Control+Home` scrolled the view to the top; the short editor viewport
  // virtualizes the diagram (at the bottom) out of the DOM. Scroll it back into
  // view before reading its id. The `(source, theme)` render cache keeps the id
  // stable across the remount, so this still asserts "no re-render".
  await editor.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const after = await editor.locator('.cm-mermaid svg').getAttribute('id');
  expect(after).toBe(before);
});
