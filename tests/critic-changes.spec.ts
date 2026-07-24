import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * Slice A: CriticMarkup track-change marks (issue 01).
 *
 * Drives the addition / deletion / substitution rendering against the fake
 * backend and asserts the user-visible behaviour:
 *
 *  - `{++new++}`   → a `.cm-critic-add` (green) span, delimiters hidden.
 *  - `{--old--}`   → a `.cm-critic-del` (red) span, delimiters hidden.
 *  - `{~~a~>b~~}`  → a `.cm-critic-del` span immediately followed by a
 *    `.cm-critic-add` span (both visible), the `~>` and delimiters hidden.
 *  - No strikethrough / underline on any tint span.
 *  - Cursor inside a mark reveals the raw markup in hybrid; never in view.
 *
 * Uses the runtime fake-watcher seed hook (like critic-annotations.spec.ts), so
 * the shared Explorer tree other specs screenshot is left untouched.
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

async function openConcept(page: Page, path: string, body: string) {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await createConcept(page, path, body);
  await expect(tree.locator(`[data-path="${path}"]`)).toBeVisible();
  await tree.locator(`[data-path="${path}"]`).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  return editor;
}

test('addition, deletion and substitution render as red/green track-change spans (delimiters hidden)', async ({
  page,
}) => {
  const editor = await openConcept(
    page,
    'critic-changes.md',
    `${fm('Critic Changes')}# Changes\n\n` +
      `An {++inserted++} phrase, a {--removed--} phrase, and a {~~before~>after~~} swap.\n`,
  );
  await expect(editor).toContainText('An');

  // Addition → green, deletion → red.
  const add = editor.locator('.cm-critic-add').first();
  const del = editor.locator('.cm-critic-del').first();
  await expect(add).toHaveText('inserted');
  await expect(del).toHaveText('removed');

  // Substitution → a del span directly followed by an add span (both visible).
  await expect(editor.locator('.cm-critic-del')).toHaveCount(2); // {--removed--} + sub `before`
  await expect(editor.locator('.cm-critic-del', { hasText: 'before' })).toHaveText('before');
  await expect(editor.locator('.cm-critic-add', { hasText: 'after' })).toHaveText('after');

  // Delimiters and the `~>` separator are hidden from the rendered DOM.
  await expect(editor).not.toContainText('{++');
  await expect(editor).not.toContainText('{--');
  await expect(editor).not.toContainText('{~~');
  await expect(editor).not.toContainText('~>');

  // No strikethrough / no underline on any tint span.
  for (const sel of ['.cm-critic-add', '.cm-critic-del']) {
    const decoration = await editor
      .locator(sel)
      .first()
      .evaluate((el) => getComputedStyle(el).textDecorationLine);
    expect(decoration).toBe('none');
  }
});

test('editing: caret inside a mark reveals raw markup; moving away collapses it', async ({
  page,
}) => {
  const editor = await openConcept(
    page,
    'critic-reveal.md',
    `${fm('Reveal')}# Reveal\n\nThe {++added++} word.\n`,
  );
  // Cursor-reveal is an editing-mode behaviour; read is the default.
  await page.getByTestId('edit-toggle').click();
  const add = editor.locator('.cm-critic-add').first();
  await expect(add).toHaveText('added');
  await expect(editor).not.toContainText('{++');

  // Click inside the added span → the raw `{++...++}` markup is revealed for editing.
  await add.click();
  await expect(editor).toContainText('{++');
  await expect(editor).toContainText('++}');

  // Move the caret out → the mark collapses again (delimiters hidden).
  await page.keyboard.press('ControlOrMeta+End');
  await expect(editor).not.toContainText('{++');
  await expect(editor.locator('.cm-critic-add').first()).toHaveText('added');
});

test('view mode: clicking a mark never reveals the raw markup', async ({ page }) => {
  const editor = await openConcept(
    page,
    'critic-view.md',
    `${fm('View')}# View\n\nThe {--gone--} word.\n`,
  );
  // Read is the default mode.

  const del = editor.locator('.cm-critic-del').first();
  await expect(del).toHaveText('gone');

  await del.click();
  await expect(editor).not.toContainText('{--');
  await expect(editor).not.toContainText('--}');
  await expect(del).toHaveText('gone');
});
