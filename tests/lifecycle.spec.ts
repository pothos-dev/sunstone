import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * ov-11: the lifecycle family — `status` (OKF §5.4) and `stale_after` (§5.5).
 *
 * A Concept past its `stale_after` is marked stale in the Explorer row and the
 * Tile header (the places a Concept is summarised) and stays fully readable and
 * editable. Staleness is derived at display time and never written back. A
 * Concept with neither key shows no lifecycle affordance. In an OKF Bundle the
 * Frontmatter editor lints `status` against the enum and completes its values.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

const STALE = 'stale-probe.md';
const STALE_CONTENT =
  '---\ntype: Metric\ntitle: Stale probe\nstatus: deprecated\nstale_after: 2000-01-01T00:00:00Z\n---\n\n# Stale probe\n\nOld facts.\n';
const DRAFT = 'draft-probe.md';
const DRAFT_CONTENT =
  '---\ntype: Metric\ntitle: Draft probe\nstatus: draft\nstale_after: 2999-01-01T00:00:00Z\n---\n\n# Draft probe\n';

async function external(page: Page, kind: string, path: string, content: string): Promise<void> {
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate(
    ([k, p, c]) => (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange(k, p, c),
    [kind, path, content] as const,
  );
}

function persisted(page: Page, path: string): Promise<string> {
  return page.evaluate((p) => (window as unknown as FakeWindow).__sunstoneFake.files[p], path);
}

const created = (page: Page, path: string, content: string) => external(page, 'created', path, content);

/** Declare the fake Bundle OKF: `okf_version` in its root `index.md`. */
async function setMarker(page: Page): Promise<void> {
  const root = await persisted(page, 'index.md');
  await external(page, 'modified', 'index.md', root.replace('---\n', '---\nokf_version: "0.2"\n'));
}

async function boot(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await created(page, STALE, STALE_CONTENT);
  await created(page, DRAFT, DRAFT_CONTENT);
}

const row = (page: Page, path: string) => page.getByTestId('tree').locator(`[data-path="${path}"]`);

test('lifecycle: a stale Concept is marked where it is summarised, and stays readable and editable', async ({
  page,
}) => {
  await boot(page);

  // The Explorer row: deprecated + stale.
  await expect(row(page, STALE).getByTestId('lifecycle-stale')).toBeVisible();
  await expect(row(page, STALE).getByTestId('lifecycle-status')).toHaveText('deprecated');
  // Draft, not yet stale: the status shows, no stale chip.
  await expect(row(page, DRAFT).getByTestId('lifecycle-status')).toHaveText('draft');
  await expect(row(page, DRAFT).getByTestId('lifecycle-stale')).toHaveCount(0);
  // Every Concept with neither key: nothing at all.
  await expect(page.getByTestId('tree').getByTestId('lifecycle')).toHaveCount(2);

  // The Tile header of the open Concept.
  await row(page, STALE).click();
  const header = page.getByTestId('tile-header');
  await expect(header.getByTestId('lifecycle-stale')).toBeVisible();
  await expect(header.getByTestId('lifecycle-status')).toHaveText('deprecated');
  await expect(header.getByTestId('lifecycle')).toHaveAttribute('title', /Stale since 2000-01-01T00:00:00Z/);

  // Fully readable…
  await expect(page.locator('.cm-content').first()).toContainText('Old facts.');
  // …and editable; the save writes the body edit and never a derived "stale".
  await page.getByTestId('edit-toggle').click();
  const body = page.getByTestId('tile').locator('.cm-content').last();
  await body.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Still editable.');
  await expect.poll(() => persisted(page, STALE), { timeout: 10_000 }).toContain('Still editable.');
  const saved = await persisted(page, STALE);
  expect(saved.startsWith(STALE_CONTENT.slice(0, STALE_CONTENT.indexOf('# Stale probe')))).toBe(true);
  expect(saved).not.toMatch(/^stale:/m);
});

test('lifecycle: a Concept with neither key shows no lifecycle affordance', async ({ page }) => {
  await boot(page);
  await created(page, 'plain-probe.md', '---\ntype: Metric\ntitle: Plain probe\n---\n\nbody\n');
  await row(page, 'plain-probe.md').click();
  await expect(row(page, 'plain-probe.md').getByTestId('lifecycle')).toHaveCount(0);
  await expect(page.getByTestId('tile-title')).toBeVisible();
  await expect(page.getByTestId('tile-header').getByTestId('lifecycle')).toHaveCount(0);
});

test('lifecycle: status is linted and completed in an OKF Bundle', async ({ page }) => {
  await boot(page);
  await created(page, 'status-probe.md', '---\ntype: Metric\ntitle: Status probe\nstatus: wip\n---\n\nbody\n');
  await row(page, 'status-probe.md').click();
  await page.getByTestId('frontmatter-toggle').click();
  const region = page.getByTestId('frontmatter');
  const yaml = region.locator('.cm-content');
  await expect(yaml).toContainText('status: wip');

  // No marker: nothing said about the value.
  await page.waitForTimeout(1500);
  await expect(region.locator('.cm-lintRange-error')).toHaveCount(0);

  // OKF Bundle: `wip` is outside the enum.
  await setMarker(page);
  await expect(region.locator('.cm-lintRange-error')).toHaveCount(1);

  // Completion offers the three values.
  await page.getByTestId('edit-toggle').click();
  await yaml.click();
  await page.keyboard.press('Control+End');
  for (const _ of 'wip') await page.keyboard.press('Backspace');
  await page.keyboard.press('Control+Space');
  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup).toBeVisible();
  for (const s of ['draft', 'stable', 'deprecated']) {
    await expect(popup.locator('.cm-completionLabel', { hasText: new RegExp(`^${s}$`) })).toHaveCount(1);
  }
  await page.keyboard.type('dra');
  await page.keyboard.press('Enter');
  await expect(yaml).toContainText('status: draft');
  await expect(region.locator('.cm-lintRange-error')).toHaveCount(0);
});
