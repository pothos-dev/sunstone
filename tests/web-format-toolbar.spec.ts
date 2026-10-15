import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import { WEB_BUNDLE_DIR } from './web-bundle';
import { mountShell, openFromTree } from './web-shell';

/**
 * aa-1 on the web: the formatting Toolbar ships in the authenticated web shell
 * too (it mounts the same `App.svelte` / `TileHeader`). Bold a word from the
 * Toolbar, Save, and the commit on disk carries the markdown; leaving editing
 * removes the row. The behavioural detail (toggle-off, readout, keyboard) is
 * proven over the fake in `format-toolbar.spec.ts`.
 */

test('web: the Toolbar shows while editing, bolds a word, and is gone in reading mode', async ({
  page,
}) => {
  const rel = 'toolbar-target.md';
  const abs = join(WEB_BUNDLE_DIR, rel);
  writeFileSync(abs, `---\ntype: concept\ntitle: Toolbar Target\n---\n\nBoldme on the web.\n`);

  try {
    await mountShell(page, '/');
    const content = await openFromTree(page, rel); // enters editing
    await expect(content).toContainText('Boldme on the web.');

    const toolbar = page.getByTestId('format-toolbar');
    await expect(toolbar).toBeVisible();

    await content.locator('.cm-line', { hasText: 'Boldme' }).first().click();
    await page.keyboard.press('Home');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
    await toolbar.getByTestId('format-bold').click();
    await expect(toolbar.getByTestId('format-bold')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('save-concept').click();
    await expect.poll(() => readFileSync(abs, 'utf8')).toContain('**Boldme** on the web.');

    // Reading mode: no Toolbar row.
    await page.getByTestId('edit-toggle').first().click();
    await expect(page.getByTestId('edit-toggle').first()).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('format-toolbar')).toHaveCount(0);
  } finally {
    rmSync(abs, { force: true });
  }
});
