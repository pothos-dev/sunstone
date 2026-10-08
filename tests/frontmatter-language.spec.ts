import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * ov-3: the Frontmatter editor's OKF language service (ADR 0009).
 *
 * The fake Bundle's root `index.md` does NOT declare `okf_version`, so it starts
 * as a plain folder of markdown: only well-formedness is linted and nothing is
 * completed. Writing the marker into the root `index.md` (an external change,
 * which refreshes the index) turns OKF lint + completion on for the SAME open
 * YAML — the lint re-runs without the document changing — and removing it turns
 * them off again.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

const PROBE = 'lint-probe.md';

/**
 * No `type`, and a `generated` block with no `by`: two OKF errors. (Not a
 * `sources` entry: that list starts folded, ov-15, which hides its marks.)
 */
const PROBE_CONTENT = '---\ntitle: Lint probe\ngenerated: { at: 2026-06-20T22:53:05Z }\n---\n\n# Lint probe\n';

async function external(page: Page, path: string, content: string): Promise<void> {
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate(
    ([p, c]) => (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('modified', p, c),
    [path, content] as const,
  );
}

async function created(page: Page, path: string, content: string): Promise<void> {
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate(
    ([p, c]) => (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('created', p, c),
    [path, content] as const,
  );
}

/** Toggle the `okf_version` marker in the fake Bundle's root `index.md`. */
async function setMarker(page: Page, on: boolean): Promise<void> {
  const root = await page.evaluate(() => (window as unknown as FakeWindow).__sunstoneFake.files['index.md']);
  const without = root.replace(/^okf_version: .*\n/m, '');
  await external(page, 'index.md', on ? without.replace('---\n', '---\nokf_version: "0.2"\n') : without);
}

async function openProbe(page: Page, content = PROBE_CONTENT, editing = false) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await created(page, PROBE, content);
  await page.getByTestId('tree').locator(`[data-path="${PROBE}"]`).click();
  await page.getByTestId('frontmatter-toggle').click();
  if (editing) await page.getByTestId('edit-toggle').click();
  const region = page.getByTestId('frontmatter');
  await expect(region.locator('.cm-content')).toContainText('title: Lint probe');
  return region;
}

test('language service: OKF lint follows the marker, without the YAML changing', async ({ page }) => {
  const region = await openProbe(page);
  const errors = region.locator('.cm-lintRange-error');

  // No marker: a plain folder of markdown. Nothing to say about `type` or `generated`.
  // (The lint is debounced 1s; give it time to have run.)
  await page.waitForTimeout(1500);
  await expect(errors).toHaveCount(0);

  // Declare the Bundle OKF: the same, untouched YAML now has two errors —
  // the missing `type` and the `generated` block with no `by`.
  await setMarker(page, true);
  await expect(errors).toHaveCount(2);
  await expect(region.locator('.cm-content')).toContainText('title: Lint probe');

  // And quiet again once the marker goes.
  await setMarker(page, false);
  await expect(errors).toHaveCount(0);
  expect(await page.evaluate((p) => (window as unknown as FakeWindow).__sunstoneFake.files[p], PROBE)).toBe(
    PROBE_CONTENT,
  );
});

test('language service: a duplicate key is reported in any Bundle', async ({ page }) => {
  const region = await openProbe(page, '---\ntitle: Lint probe\ntitle: again\n---\n\nbody\n');
  await expect(region.locator('.cm-lintRange-error')).toHaveCount(1);
  // A lint error never holds the write: no "not being saved" indicator.
  await expect(page.getByTestId('frontmatter-error')).toHaveCount(0);
});

test('language service: key completion only in an OKF Bundle', async ({ page }) => {
  const region = await openProbe(page, '---\ntype: Metric\ntitle: Lint probe\n---\n\nbody\n', true);
  const yaml = region.locator('.cm-content');
  const popup = page.locator('.cm-tooltip-autocomplete');

  // No marker: typing a key offers nothing.
  await yaml.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nsou');
  await page.waitForTimeout(300);
  await expect(popup).toHaveCount(0);
  for (const _ of 'sou') await page.keyboard.press('Backspace');

  // Marker on: the recommended and family keys are offered; present ones are not.
  await setMarker(page, true);
  await page.keyboard.type('t');
  await expect(popup).toBeVisible();
  const label = (text: string) => popup.locator('.cm-completionLabel', { hasText: new RegExp(`^${text}$`) });
  await expect(label('tags')).toHaveCount(1);
  await expect(label('type')).toHaveCount(0);
  await expect(label('title')).toHaveCount(0);
  await page.keyboard.type('ag');
  await expect(popup).toContainText('tags');
  await page.keyboard.press('Enter');
  await expect(yaml).toContainText('tags:');

  // Inside a family that is present: its nested keys.
  await page.keyboard.type('[a]\ngenerated:\n  ');
  await page.keyboard.press('Control+Space');
  await expect(label('by')).toHaveCount(1);
  await expect(label('at')).toHaveCount(1);
});
