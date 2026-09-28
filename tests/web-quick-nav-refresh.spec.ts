import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import { WEB_BUNDLE_DIR } from './web-bundle';

/** A scratch Concept written into the SERVED Bundle after the palette loaded. */
const NOTE = join(WEB_BUNDLE_DIR, 'quicknav-fresh.md');

/**
 * The anon web Quick nav palette caches its Concept list across opens, but a
 * live reload (SSE `file-changed` → the viewer's `indexVersion` bump) must
 * invalidate that cache: a Concept created on disk AFTER the first Ctrl+K is
 * listed the next time the palette opens.
 */
test('quick-nav: a Concept created after the first open is listed after live reload', async ({
  page,
}) => {
  await rm(NOTE, { force: true });
  const row = page.getByTestId('tree-concept').filter({ hasText: 'quicknav-fresh' });
  const item = page.locator('[data-testid="quick-nav-item"][data-path="quicknav-fresh.md"]');

  await page.goto('/');
  await expect(page.getByTestId('web-viewer')).toBeVisible();
  // Gate on hydration (the Tags Section renders from a client-side fetch in
  // the same cycle that installs the key listeners).
  await expect(page.getByTestId('tag-browser')).toBeVisible();

  // First open: the palette loads (and caches) the Concept list.
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('quick-nav-item').first()).toBeVisible();
  await page.getByTestId('quick-nav-input').fill('quicknav-fresh');
  await expect(item).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-nav')).toHaveCount(0);

  // Let the EventSource finish subscribing (no DOM signal for "SSE open").
  await page.waitForTimeout(1500);

  try {
    await writeFile(NOTE, '# Quick nav fresh\n\nbody\n');
    // The tree refresh proves the live reload reached the viewer.
    await expect(row).toHaveCount(1, { timeout: 15_000 });

    await page.keyboard.press('Control+k');
    await page.getByTestId('quick-nav-input').fill('quicknav-fresh');
    await expect(item).toHaveCount(1);
  } finally {
    await rm(NOTE, { force: true });
  }
});
