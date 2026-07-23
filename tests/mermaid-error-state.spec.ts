import { test, expect } from '@playwright/test';

/**
 * Slice: mermaid-error-state (ADR-0005, option 4a).
 *
 * When `mermaid.render()` fails on invalid source, the widget must show a
 * bordered error panel (mermaid's message) with the raw fence source beneath it,
 * visibly distinct from a plain fenced code block. Fixing the source (cursor
 * leaves the block, field rebuilds) re-renders the diagram and clears the error.
 *
 * Drives the fake backend's rich Concept (carries a ` ```mermaid ` fence): reveal
 * the raw fence by clicking the rendered Diagram, break the body, move the cursor
 * out so it re-renders, and assert the error panel + raw source appear.
 */
test('mermaid: invalid source renders a bordered error panel with the raw source', async ({
  page,
}) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Obsidian-style hybrid editing');

  // Read is the default; enter editing so clicking the Diagram reveals the raw
  // fence source and the source can be edited to break the render.
  await page.getByTestId('edit-toggle').click();

  // Bring the mermaid fence into view so CM6 mounts its line DOM + widget.
  await editor.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  // The diagram renders first (valid source, cursor outside).
  const diagram = editor.locator('.cm-mermaid svg');
  await expect(diagram).toBeVisible({ timeout: 15000 });

  // Click the Diagram to lift the block-replace and reveal the raw `graph TD`
  // source for editing (hybrid).
  await diagram.click();
  await expect(editor).toContainText('graph TD');

  // Break the diagram: replace the `graph TD` line (the diagram TYPE) with a
  // token mermaid cannot parse, so the next render throws. Click that specific
  // line first so the caret is on it (the reveal click above lands the caret at
  // the fence boundary, not necessarily this line) — replacing the wrong line
  // could clobber a ``` fence marker and drop the block entirely.
  await editor.locator('.cm-line').filter({ hasText: 'graph TD' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.type('!!!not a diagram!!!');

  // Move the cursor far out of the fence so the block-replace re-applies and the
  // widget re-renders the (now invalid) source.
  await editor.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  await editor.locator('.cm-content').click({ position: { x: 5, y: 5 } });

  // Bring the fence back into view: the short editor viewport virtualizes the
  // (now error) widget out of the DOM when scrolled to the top.
  await editor.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  // The error panel appears: bordered, with mermaid's message, distinct from a
  // plain code block (own `.cm-mermaid-error` class).
  const errorPanel = editor.locator('.cm-mermaid-error');
  await expect(errorPanel).toBeVisible({ timeout: 15000 });
  await expect(editor.locator('.cm-mermaid-error-message')).not.toBeEmpty();

  // The raw fence source is shown beneath the error message.
  await expect(editor.locator('.cm-mermaid-error-source')).toContainText(
    '!!!not a diagram!!!',
  );

  await page.screenshot({
    path: 'tests/screenshots/mermaid-error-state.png',
    fullPage: true,
  });
});
