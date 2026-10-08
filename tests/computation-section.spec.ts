import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * ov-13: the `# Computation` conventional body heading. In an Attested
 * Computation the section from `# Computation` to the next peer heading is set
 * apart (line classes in the editor, read and edit modes alike); it lists in the
 * Outline like any heading and edits like any section. On any other type it is
 * an ordinary heading. Driven against the fake backend.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

const PROBE = 'computation-section-probe.md';

const BODY =
  '# Revenue\n\nSection probe intro.\n\n## Computation\n\n    SELECT SUM(amount)\n\nBinds only year.\n\n' +
  '## Notes\n\nAfter the section.\n';

async function openProbe(page: Page, type: string, body = BODY) {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.waitForFunction(() => '__sunstoneFake' in window);
  const content = `---\ntype: ${type}\nruntime: bigquery\n---\n\n${body}`;
  await page.evaluate(
    ([p, c]) => (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('created', p, c),
    [PROBE, content] as const,
  );
  await tree.locator(`[data-path="${PROBE}"]`).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Section probe intro.');
  return editor;
}

test('computation section: set apart in read and edit mode, listed in the Outline', async ({ page }) => {
  const editor = await openProbe(page, 'Attested Computation');
  const section = editor.locator('.cm-line.cm-computation-section');
  // Reading (the default): heading through "Binds only year." — not the intro, not Notes.
  await expect(editor.locator('.cm-computation-section-head')).toHaveText('Computation');
  await expect(editor.locator('.cm-computation-section-last')).toHaveText('Binds only year.');
  await expect(editor.locator('.cm-line', { hasText: 'Section probe intro.' })).not.toHaveClass(/cm-computation-section/);
  await expect(editor.locator('.cm-line', { hasText: 'After the section.' })).not.toHaveClass(/cm-computation-section/);
  const readCount = await section.count();
  expect(readCount).toBeGreaterThanOrEqual(3);

  // The Outline lists it like any other heading.
  await page.getByTestId('rail-toggle-right').click();
  const entries = page.getByTestId('outline').getByTestId('outline-entry');
  await expect(entries).toHaveText(['Revenue', 'Computation', 'Notes']);

  // Edit mode: same span; typing inside it is ordinary editing.
  await page.getByTestId('edit-toggle').click();
  await expect(editor.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await expect(editor.locator('.cm-computation-section-head')).toHaveText(/Computation/);
  await editor.locator('.cm-line', { hasText: 'Binds only year.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Edited inside.');
  await expect(editor.locator('.cm-computation-section-last')).toHaveText('Binds only year. Edited inside.');
  // A new line at the section's end joins it.
  await page.keyboard.press('Enter');
  await page.keyboard.type('Another line.');
  await expect(editor.locator('.cm-computation-section-last')).toHaveText('Another line.');
  await expect
    .poll(() => page.evaluate((p) => (window as unknown as FakeWindow).__sunstoneFake.files[p], PROBE))
    .toContain('Binds only year. Edited inside.\nAnother line.\n');
  const saved = await page.evaluate((p) => (window as unknown as FakeWindow).__sunstoneFake.files[p], PROBE);
  expect(saved).not.toContain('computation-section');
});

test('computation section: an ordinary heading on another type', async ({ page }) => {
  const editor = await openProbe(page, 'Metric');
  await expect(editor.locator('.cm-line', { hasText: 'Binds only year.' })).toBeVisible();
  await expect(editor.locator('.cm-computation-section')).toHaveCount(0);
});

test('computation section: an Attested Computation without one renders normally', async ({ page }) => {
  const editor = await openProbe(page, 'Attested Computation', '# Revenue\n\nSection probe intro.\n\n## Notes\n\nx\n');
  await expect(editor.getByTestId('computation')).toHaveCount(1);
  await expect(editor.locator('.cm-computation-section')).toHaveCount(0);
  await expect(editor.locator('.cm-line', { hasText: 'Notes' })).toBeVisible();
});
