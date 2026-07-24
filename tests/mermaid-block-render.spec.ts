import { test, expect } from '@playwright/test';

/**
 * Slice: mermaid-block-render (ADR-0005).
 *
 * Drives the parallel `mermaidBlocks()` StateField against the fake backend's
 * rich Concept, which carries a ` ```mermaid ` fence. Asserts the tracer-bullet
 * render path:
 *  - the mermaid fence renders as an SVG Diagram in hybrid (cursor outside),
 *  - a non-mermaid fence (the ```ts block) still renders as a code block,
 *  - placing the cursor inside the fence (hybrid) reveals the raw `graph TD`
 *    source (the block-replace lifts),
 *  - reading (view) mode always renders the Diagram,
 * and saves a screenshot showing the rendered Diagram.
 *
 * mermaid is lazy-loaded (dynamic import) and renders client-side, so the SVG
 * assertions poll rather than expect immediate presence.
 */
test('mermaid: a mermaid fence renders as an SVG diagram; cursor reveals raw', async ({
  page,
}) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Obsidian-style hybrid editing');

  // Enter editing (read is the default) — the cursor-reveal below is an
  // editing-only behaviour; the diagram renders the same in both modes.
  await page.getByTestId('edit-toggle').click();

  // --- A non-mermaid fenced block is unaffected (still a code block) --------
  // The ```ts block (near the top of the doc) renders with the atomic-editor
  // fenced-code class, proving mermaid handling didn't swallow ordinary code
  // fences. Assert it BEFORE scrolling to the mermaid fence: the editor viewport
  // is short, so scrolling to the bottom virtualizes this top block out of the
  // DOM (CM6 only mounts line DOM for the visible range).
  await expect(editor.locator('.cm-atomic-fenced-code').first()).toBeVisible();

  // Bring the mermaid fence (lower in the doc) into the viewport so CM6 mounts
  // its line DOM and the block widget renders.
  await editor.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  // --- The mermaid fence renders as an SVG Diagram (hybrid, cursor outside) --
  const diagram = editor.locator('.cm-mermaid svg');
  await expect(diagram).toBeVisible({ timeout: 15000 });

  await page.screenshot({
    path: 'tests/screenshots/mermaid-block-render.png',
    fullPage: true,
  });

  // --- Cursor inside the fence (hybrid) reveals the raw source --------------
  // Click the rendered Diagram to land the caret in/near the fence, then assert
  // the raw `graph TD` markup becomes visible (the block-replace lifted).
  await diagram.click();
  // The raw fence source is now in the document text.
  await expect(editor).toContainText('graph TD');
});

/**
 * Reading (view) mode always renders the Diagram, regardless of the cursor —
 * the block-replace never lifts in view mode.
 */
test('mermaid: reading mode always renders the diagram', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();

  // Read is the default mode.

  await editor.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  const diagram = editor.locator('.cm-mermaid svg');
  await expect(diagram).toBeVisible({ timeout: 15000 });

  // Clicking the diagram in reading mode must NOT reveal the raw fence — view
  // mode always renders. The raw `graph TD` markup stays hidden.
  await diagram.click();
  await expect(editor).not.toContainText('graph TD');
});
