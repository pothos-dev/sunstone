import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * ov-14: footnotes.
 *
 * A `[^label]` reference renders as a superscript `[n]` (`.cm-footnote-ref`), n
 * by first reference, in the live-preview editor; clicking it scrolls to the
 * `[^label]:` definition and flashes that line (`.cm-citation-target`, the flash
 * the citations share). A definition's marker renders as a `[n]` row head
 * (`.cm-footnote-def`). A label matching a `sources[].id` resolves without a
 * body definition; one with neither is broken. Driven against the fake backend.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
  };
};

const BODY =
  `---\ntype: concept\ntitle: WMC\nsources:\n  - id: ssi-web\n    resource: https://x.example\n---\n\n# WMC\n\n` +
  'Die WMC App ist der mobile Client [^21][^2]. Ein Satz ohne Quelle [^99]. Laut SSI [^ssi-web].\n\n' +
  `${'Filler paragraph to push the definitions down.\n\n'.repeat(30)}` +
  '# Quellen\n\n' +
  '[^2]: SSI Schäfer, WAMAS Maintenance Center.\n' +
  '[^21]: Projektauftrag Phase 1.\n';

async function openConcept(page: Page) {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate((b) => {
    (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('created', 'wmc.md', b);
  }, BODY);
  await tree.locator('[data-path="wmc.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Die WMC App');
  return editor;
}

test('references number by first use, with the label on hover', async ({ page }) => {
  const editor = await openConcept(page);
  const refs = editor.locator('.cm-footnote-ref');
  await expect(refs).toHaveCount(4);
  await expect(refs.nth(0)).toHaveText('[1]');
  await expect(refs.nth(0)).toHaveAttribute('title', '21');
  await expect(refs.nth(1)).toHaveText('[2]');
  await expect(refs.first()).toHaveJSProperty('tagName', 'SUP');
  // `[^99]` has neither a definition nor a source.
  await expect(refs.nth(2)).toHaveText('[3]');
  await expect(refs.nth(2)).toHaveClass(/cm-footnote-broken/);
  // `[^ssi-web]` has no body definition but matches a `sources` id.
  await expect(refs.nth(3)).toHaveText('[4]');
  await expect(refs.nth(3)).toHaveAttribute('title', 'ssi-web');
  await expect(refs.nth(3)).not.toHaveClass(/cm-footnote-broken/);
  await expect(editor.locator('.cm-footnote-broken')).toHaveCount(1);
});

test('clicking a reference jumps to its definition and flashes it', async ({ page }) => {
  const editor = await openConcept(page);
  const defLine = editor.locator('.cm-line', { hasText: 'Projektauftrag' }).first();

  await editor.locator('.cm-footnote-ref[title="21"]').click();

  await expect(editor.locator('.cm-citation-target')).toBeVisible();
  await expect(defLine).toBeInViewport();
  // The definition marker renders as a row head. (The click does not focus the
  // editor, so the caret parked on the line does not reveal the raw marker.)
  await expect(defLine.locator('.cm-footnote-def')).toHaveText('[1]');
});
