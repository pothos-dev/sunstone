import { test, expect } from '@playwright/test';

/**
 * Slice: live-preview (ADR 0001).
 *
 * Drives the atomic-editor hybrid live preview against the fake backend on a
 * Concept with rich markdown (heading, bold, task list, fenced code block,
 * GFM table, inline image). Asserts:
 *  - inactive lines render styled (heading element styled, strong styled),
 *  - a fenced code block is syntax-highlighted (tokens get highlight classes),
 *  - a GFM table renders as the interactive table widget,
 *  - an inline image widget renders,
 *  - placing the cursor on a styled line reveals its raw markdown markup,
 * and saves a screenshot showing rendered markdown.
 */
test('live preview: rich markdown renders, cursor line shows raw markup', async ({
  page,
}) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Open the rich Concept.
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Obsidian-style hybrid editing');

  // Live preview (cursor-line reveal) is the editing mode; read is the default.
  await page.getByTestId('edit-toggle').click();

  // --- Inactive lines render styled ---------------------------------------
  // Heading rendered with the atomic-editor heading class (sized via theme).
  const h1 = editor.locator('.cm-atomic-h1').first();
  await expect(h1).toBeVisible();
  await expect(h1).toContainText('Live Preview');

  // Bold text rendered styled.
  await expect(editor.locator('.cm-atomic-strong').first()).toBeVisible();

  // Task checkbox rendered (GFM task list — requires the markdownLanguage base).
  await expect(editor.locator('.cm-atomic-task-checkbox').first()).toBeVisible();

  // --- Fenced code block syntax-highlighted -------------------------------
  // The ts grammar loads lazily; once it does, tokens get highlight classes.
  await expect(editor.locator('.cm-atomic-fenced-code').first()).toBeVisible();
  await expect
    .poll(async () => editor.locator('.cm-line .ͼ1, .cm-line [class*="ͼ"]').count())
    .toBeGreaterThan(0);

  // --- GFM table renders as the interactive widget ------------------------
  const table = editor.locator('.cm-atomic-table table').first();
  await expect(table).toBeVisible();
  await expect(table).toContainText('Status');

  // --- Inline image widget renders (data URI -> fully renders) ------------
  // (.cm-widgetBuffer is a CM6 internal zero-size img; match the real widget
  // by its src instead.) The relative `./assets/diagram.png` image also
  // renders its widget but 404s — there is no static file server under the
  // fake backend; that is expected and noted in the slice report.
  const img = editor.locator('.cm-content img[src^="data:image"]').first();
  await expect(img).toBeVisible();

  // --- Cursor line reveals raw markdown markup ----------------------------
  // On an inactive heading line the leading `#` is hidden by the live preview.
  // Click the heading to move the cursor onto it; the raw `# Live Preview`
  // markup must then be visible, and the layout must not jump (heading stays).
  const before = await h1.boundingBox();
  await h1.click();
  // The active line now contains the raw markup including the `#` marker.
  const activeLine = editor.locator('.cm-activeLine').first();
  await expect(activeLine).toContainText('# Live Preview');
  const after = await editor.locator('.cm-atomic-h1, .cm-activeLine').first().boundingBox();
  // No vertical layout jump: the heading line stays at the same top position.
  if (before && after) {
    expect(Math.abs(after.y - before.y)).toBeLessThan(4);
  }

  await page.screenshot({
    path: 'tests/screenshots/live-preview.png',
    fullPage: true,
  });
});

/**
 * Regression (patched @atomic-editor/editor): a bare/GFM-autolinked URL — a
 * `https://…` standalone in running text, as OKF `# Citations` sections use —
 * parses as a `URL` node with NO `Link` parent. Upstream atomic-editor treated
 * every `URL` node as the href half of `[text](url)` and HID it on inactive
 * lines, leaving the line blank and only showing the URL when the cursor landed
 * on it. The patch keeps bare URLs visible and styles them as links. This guards
 * that fix: the autolink text is present on an inactive line and carries the
 * link class (so it's clickable), without the cursor being on it.
 */
test('live preview: bare/autolinked URLs render styled on inactive lines', async ({
  page,
}) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Obsidian-style hybrid editing');

  // The Citations section sits at the bottom of the doc. CodeMirror virtualizes
  // off-screen lines, so scroll the scroller (NOT the cursor — focusing would
  // mark the line active and mask the inactive-line render path that had the
  // bug) to bring the bare URL into the DOM.
  await editor.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  // The bare URL must be visible (not hidden) even though the cursor is not on
  // it — the bug rendered it as a blank line until clicked.
  const url = editor.locator('.cm-atomic-link', {
    hasText: 'https://example.com/bare-autolink',
  });
  await expect(url).toBeVisible();

  // It carries the link class but is NOT on the active line — proving the
  // inactive-line render path (where the bug blanked it) now keeps it visible.
  const onActiveLine = url.locator('xpath=ancestor::*[contains(@class, "cm-activeLine")]');
  await expect(onActiveLine).toHaveCount(0);
});

/**
 * Regression (patched @atomic-editor/editor): the OKF `# Citations` format
 * writes a numeric marker followed by a proper link, e.g.
 * `[1] [BigQuery table schema](https://…)`. The `[1]` is a bracketed span with
 * NO destination, but lezer still parses it as a `Link` node. Upstream
 * atomic-editor styled every `Link` as a link AND hid its brackets, so `[1]`
 * rendered as a lone styled "1" with the brackets gone. The patch skips both
 * for url-less Links, so `[1]` renders as literal `[1]` text and is NOT a link.
 */
test('live preview: url-less citation marker [1] renders as literal text, not a link', async ({
  page,
}) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Obsidian-style hybrid editing');

  // Bring the Citations section into the DOM without focusing a line (focusing
  // would mark it active and reveal raw markup, masking the inactive-line path
  // that had the bug).
  await editor.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  // The brackets are NOT hidden: the literal `[1]` text is present on an
  // inactive line (the bug rendered it as a bare "1" with brackets stripped).
  const citationLine = editor.locator('.cm-line', { hasText: 'BigQuery table schema' });
  await expect(citationLine).toContainText('[1]');

  // The `[1]` marker carries NO link styling — only the real `[label](url)`
  // link on the same line does. Assert no link element wraps the `[1]` text.
  const markerAsLink = citationLine.locator('.cm-atomic-link', { hasText: '1' })
    .filter({ hasNotText: 'BigQuery' });
  await expect(markerAsLink).toHaveCount(0);

  // The real link on the line IS styled as a link (sanity: the patch didn't
  // over-suppress genuine links).
  await expect(
    citationLine.locator('.cm-atomic-link', { hasText: 'BigQuery table schema' }),
  ).toBeVisible();
});
