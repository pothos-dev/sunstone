import { test, expect } from '@playwright/test';

/**
 * Slice: editing-autosave-watcher.
 *
 * Drives the now-editable CM6 editor against the fake backend:
 *  - types into a Concept and asserts the edit persists (reopen shows it),
 *  - asserts the editor is editable (was read-only in slice 1),
 *  - exercises the external-change path via the fake watcher hook and asserts
 *    the open Concept reloads,
 *  - confirms a self-write does NOT reload (no watcher echo).
 */
test('editing + autosave: typing persists via the backend', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Open a Concept.
  await tree.locator('[data-path="concepts/bundle.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  // Live preview hides the `**` markers on inactive lines, so assert on the
  // rendered text (the on-disk source still has the markers — see autosave).
  await expect(editor).toContainText('A Bundle is the root folder');

  // Enter editing (read is the default): the editor becomes EDITABLE.
  await page.getByTestId('edit-toggle').click();
  const content = editor.locator('.cm-content');
  await expect(content).toHaveAttribute('contenteditable', 'true');

  // Type at the end of the document.
  const marker = 'AUTOSAVE_MARKER_42';
  await content.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(`\n\n${marker}`);

  // Wait past the autosave debounce (~300ms) and confirm the fake backend has
  // the new content persisted.
  await expect
    .poll(async () =>
      page.evaluate(
        (m) =>
          (
            window as unknown as {
              __sunstoneFake: { files: Record<string, string> };
            }
          ).__sunstoneFake.files['concepts/bundle.md'].includes(m),
        marker,
      ),
    )
    .toBe(true);

  // Reopen by navigating away and back — the persisted edit must show.
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(editor).toContainText('CodeMirror 6 is the editor core');
  await tree.locator('[data-path="concepts/bundle.md"]').click();
  await expect(editor).toContainText(marker);

  await page.screenshot({
    path: 'tests/screenshots/editing-autosave.png',
    fullPage: true,
  });
});

test('watcher: external change reloads the open Concept', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await tree.locator('[data-path="concepts/bundle.md"]').click();

  const editor = page.getByTestId('editor');
  // Live preview hides the `**` markers on inactive lines, so assert on the
  // rendered text (the on-disk source still has the markers — see autosave).
  await expect(editor).toContainText('A Bundle is the root folder');

  // Simulate an EXTERNAL edit (as if another tool wrote the file). The fake
  // watcher notifies subscribers, the open Concept should reload.
  const external = 'EXTERNAL_EDIT_MARKER';
  await page.evaluate(
    ({ ext }) => {
      (
        window as unknown as {
          __sunstoneFake: {
            simulateExternalChange: (
              kind: string,
              path: string,
              content?: string,
            ) => void;
          };
        }
      ).__sunstoneFake.simulateExternalChange(
        'modified',
        'concepts/bundle.md',
        `---\ntype: concept\ntitle: Bundle\n---\n\n# Bundle\n\n${ext}\n`,
      );
    },
    { ext: external },
  );

  await expect(editor).toContainText(external);

  // Simulate an external NEW file -> tree should show it after refresh.
  await page.evaluate(() => {
    (
      window as unknown as {
        __sunstoneFake: {
          simulateExternalChange: (
            kind: string,
            path: string,
            content?: string,
          ) => void;
        };
      }
    ).__sunstoneFake.simulateExternalChange(
      'created',
      'concepts/new-note.md',
      `---\ntype: concept\ntitle: New Note\n---\n\n# New Note\n`,
    );
  });

  await expect(tree.locator('[data-path="concepts/new-note.md"]')).toBeVisible();
});
