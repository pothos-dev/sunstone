import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * aa-1: the formatting Toolbar — the second row of the Concept header, shown
 * only while the Tile is editing. Drives it over the fake backend: apply a
 * format by clicking, toggle it off again, read the active state back as the
 * caret moves, and check reading mode has no Toolbar at all. Asserts against
 * the fake's persisted source (`__sunstoneFake.files`).
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

const fm = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n`;

async function createConcept(page: Page, path: string, body: string): Promise<void> {
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate(
    ([p, b]) => {
      (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('created', p, b);
    },
    [path, body] as const,
  );
}

const persisted = (page: Page, path: string) =>
  page.evaluate((p) => (window as unknown as FakeWindow).__sunstoneFake.files[p], path);

/** Open `path` (created with `body`) and switch the Tile to editing. */
async function openEditing(page: Page, path: string, body: string): Promise<void> {
  await page.goto('/');
  await createConcept(page, path, body);
  const tree = page.getByTestId('tree');
  await expect(tree.locator(`[data-path="${path}"]`)).toBeVisible();
  await tree.locator(`[data-path="${path}"]`).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.getByTestId('edit-toggle').click();
  await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'true');
}

/** Put the caret at `offset` characters into the line containing `text`. */
async function caretInLine(page: Page, text: string, offset: number): Promise<void> {
  const line = page.getByTestId('editor').locator('.cm-line', { hasText: text }).first();
  await line.click();
  await page.keyboard.press('Home');
  for (let i = 0; i < offset; i++) await page.keyboard.press('ArrowRight');
}

/** The text of the editor's current DOM selection. */
const selectedText = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? '');

/** Whether keyboard focus is in the body editor's text. */
const editorFocused = (page: Page) =>
  page.evaluate(
    () => !!document.activeElement?.closest('[data-testid="editor"] .cm-content'),
  );

test('format toolbar: absent in reading mode, a header row while editing', async ({ page }) => {
  await page.goto('/');
  await createConcept(page, 'tb-mode.md', `${fm('Mode')}# Mode\n\nSome text.\n`);
  await page.getByTestId('tree').locator('[data-path="tb-mode.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('Some text.');

  const header = page.getByTestId('tile-header');
  // Reading mode (the default) is inert: no Toolbar row at all.
  await expect(page.getByTestId('format-toolbar')).toHaveCount(0);

  await page.getByTestId('edit-toggle').click();
  const toolbar = header.getByTestId('format-toolbar');
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveAttribute('role', 'toolbar');
  for (const id of ['heading', 'bold', 'italic', 'strike', 'code', 'link']) {
    await expect(toolbar.getByTestId(`format-${id}`)).toBeVisible();
  }
  // A second row: below the Edit toggle's row, not beside it.
  const toggleBox = (await page.getByTestId('edit-toggle').boundingBox())!;
  const toolbarBox = (await toolbar.boundingBox())!;
  expect(toolbarBox.y).toBeGreaterThanOrEqual(toggleBox.y + toggleBox.height);

  // Each control teaches its hotkey.
  await expect(toolbar.getByTestId('format-bold')).toHaveAttribute('title', /Bold \((Ctrl|Cmd)\+B\)/);
  await expect(toolbar.getByTestId('format-italic')).toHaveAttribute('title', /\+I\)/);
  await expect(toolbar.getByTestId('format-strike')).toHaveAttribute('title', /\+Shift\+M\)/);
  await expect(toolbar.getByTestId('format-code')).toHaveAttribute('title', /\+E\)/);
  await expect(toolbar.getByTestId('format-heading')).toHaveAttribute('title', /\+1 to .*\+6/);

  // Back to reading: the row goes away again.
  await page.getByTestId('edit-toggle').click();
  await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('format-toolbar')).toHaveCount(0);
});

test('format toolbar: Bold applies, reads back active, and toggles off', async ({ page }) => {
  await openEditing(page, 'tb-bold.md', `${fm('Bold')}# Bold\n\nHighlightme is the word.\n`);
  const bold = page.getByTestId('format-bold');
  await expect(bold).toHaveAttribute('aria-pressed', 'false');

  // Select the word, click Bold.
  await caretInLine(page, 'Highlightme', 0);
  for (let i = 0; i < 11; i++) await page.keyboard.press('Shift+ArrowRight');
  await bold.click();
  await expect.poll(() => persisted(page, 'tb-bold.md')).toContain('**Highlightme** is the word.');

  // Focus is back in the editor, the selection still covers the word, and the
  // control reads the format it just applied.
  expect(await editorFocused(page)).toBe(true);
  expect(await selectedText(page)).toBe('Highlightme');
  await expect(bold).toHaveAttribute('aria-pressed', 'true');

  // Clicking again over the same selection removes it (the toggle).
  await bold.click();
  await expect.poll(() => persisted(page, 'tb-bold.md')).toContain('\nHighlightme is the word.');
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
  expect(await editorFocused(page)).toBe(true);
  expect(await selectedText(page)).toBe('Highlightme');
});

test('format toolbar: pressed states follow the caret', async ({ page }) => {
  await openEditing(
    page,
    'tb-state.md',
    `${fm('State')}## Second level\n\nplain **strong** and *slanted* and \`mono\` and ~~gone~~.\n`,
  );
  const ctl = (id: string) => page.getByTestId(`format-${id}`);
  const pressed = async () => {
    const out: string[] = [];
    for (const id of ['bold', 'italic', 'code', 'strike', 'link']) {
      if ((await ctl(id).getAttribute('aria-pressed')) === 'true') out.push(id);
    }
    return out;
  };

  // The heading picker reads the caret line's level.
  await caretInLine(page, 'Second level', 5);
  await expect(ctl('heading')).toHaveValue('2');

  // `plain **strong** and *slanted* and `mono` and ~~gone~~.`
  const line = 'plain';
  await caretInLine(page, line, 2); // in "plain"
  await expect(ctl('heading')).toHaveValue('0');
  await expect.poll(pressed).toEqual([]);
  await caretInLine(page, line, 10); // in "strong"
  await expect.poll(pressed).toEqual(['bold']);
  await caretInLine(page, line, 24); // in "slanted"
  await expect.poll(pressed).toEqual(['italic']);
  await caretInLine(page, line, 37); // in "mono"
  await expect.poll(pressed).toEqual(['code']);
  await caretInLine(page, line, 48); // in "gone"
  await expect.poll(pressed).toEqual(['strike']);
});

test('format toolbar: heading picker sets the level and returns focus', async ({ page }) => {
  await openEditing(page, 'tb-heading.md', `${fm('Heading')}Make me a heading.\n`);
  await caretInLine(page, 'Make me a heading.', 4);
  const picker = page.getByTestId('format-heading');
  await expect(picker).toHaveValue('0');

  await picker.selectOption('2');
  await expect.poll(() => persisted(page, 'tb-heading.md')).toContain('\n## Make me a heading.');
  await expect(picker).toHaveValue('2');
  expect(await editorFocused(page)).toBe(true);

  await picker.selectOption('0');
  await expect.poll(() => persisted(page, 'tb-heading.md')).toContain('\nMake me a heading.');
  await expect(picker).toHaveValue('0');
});

test('format toolbar: link inserts a scaffold, then reads as Edit link', async ({ page }) => {
  await openEditing(page, 'tb-link.md', `${fm('Link')}Linkme please.\n`);
  await caretInLine(page, 'Linkme', 0);
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
  const link = page.getByTestId('format-link');
  await expect(link).toHaveAttribute('aria-label', 'Insert link');
  await link.click();
  await expect.poll(() => persisted(page, 'tb-link.md')).toContain('[Linkme]() please.');
  // The caret is parked in the empty URL, inside the link.
  expect(await editorFocused(page)).toBe(true);
  await expect(link).toHaveAttribute('aria-pressed', 'true');
  await expect(link).toHaveAttribute('aria-label', 'Edit link');
});

test('format toolbar: keyboard — Alt+F10 in, arrows across, Escape back to the text', async ({
  page,
}) => {
  await openEditing(page, 'tb-keys.md', `${fm('Keys')}Keyword here.\n`);
  await caretInLine(page, 'Keyword', 0);
  for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+ArrowRight');

  await page.keyboard.press('Alt+F10');
  // One Tab stop: the first control (the heading picker) takes focus.
  await expect(page.getByTestId('format-heading')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('format-bold')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('format-italic')).toBeFocused();
  await expect(page.getByTestId('format-bold')).toHaveAttribute('tabindex', '-1');
  await expect(page.getByTestId('format-italic')).toHaveAttribute('tabindex', '0');

  // Enter activates the focused control over the editor's (kept) selection and
  // hands focus back to the text.
  await page.keyboard.press('Enter');
  await expect.poll(() => persisted(page, 'tb-keys.md')).toContain('*Keyword* here.');
  expect(await editorFocused(page)).toBe(true);

  // Escape from the Toolbar peels back to the editor text, not further.
  await page.keyboard.press('Alt+F10');
  await expect(page.getByTestId('format-italic')).toBeFocused();
  await page.keyboard.press('Escape');
  expect(await editorFocused(page)).toBe(true);
});

test('format toolbar: fits the header in a third-width Column', async ({ page }) => {
  await openEditing(page, 'tb-narrow.md', `${fm('Narrow')}Narrow text.\n`);
  // Three Columns: the Editor pane split twice.
  await page.getByTestId('split-right').first().click();
  await page.getByTestId('split-right').first().click();
  await expect(page.getByTestId('tile')).toHaveCount(3);

  const headers = page.getByTestId('tile-header');
  for (let i = 0; i < 3; i++) {
    const header = headers.nth(i);
    const toolbar = header.getByTestId('format-toolbar');
    await expect(toolbar).toBeVisible();
    // Nothing spills out of the header sideways, and every control is inside it.
    const overflow = await header.evaluate((h) => h.scrollWidth - h.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const hb = (await header.boundingBox())!;
    for (const id of ['heading', 'bold', 'link']) {
      const b = (await toolbar.getByTestId(`format-${id}`).boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(hb.x - 0.5);
      expect(b.x + b.width).toBeLessThanOrEqual(hb.x + hb.width + 0.5);
    }
  }
});
