import { test, expect } from './fixtures';

/**
 * ov-24 in the anonymous web reader: the Concept metadata pill sits in the
 * Tile header (from wr-1) and is in the SSR HTML; hovering it opens the same
 * popover as the desktop. The server-rendered body has no trust line, and its
 * Sources entries show their signals on one line with relative times. Print
 * has no hover, so the print view keeps a static trust line under the title.
 * The page clock is pinned so relative times are stable.
 */

const NOW = new Date('2026-06-28T09:00:00Z');

test('the pill is server-rendered; the body has no trust line', async ({ request }) => {
  const html = await (await request.get('/cited')).text();
  expect(html).toContain('data-testid="meta-pill"');
  expect(html).toMatch(/data-testid="meta-pill-trust"[^>]*>.*Reviewed/s);
  expect(html).toMatch(/data-testid="meta-pill-sources"[^>]*>.*2/s);
  expect(html).not.toContain('data-testid="trust"');
});

test('hovering the pill opens the popover', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.goto('/cited');
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Cited Concept');
  await expect(page.getByTestId('tags-section')).toBeVisible();

  const pill = page.getByTestId('tile-header').getByTestId('meta-pill');
  await expect(pill.getByTestId('meta-pill-trust')).toHaveText('Reviewed');
  await expect(pill.getByTestId('meta-pill-sources')).toHaveText('2');
  await expect(pill.getByTestId('meta-pill-lifecycle')).toHaveCount(0);

  await pill.hover();
  const popover = page.getByTestId('meta-popover');
  await expect(popover).toBeVisible();
  const stamps = popover.getByTestId('meta-popover-trust').getByTestId('meta-popover-stamp');
  await expect(stamps.nth(0).locator('.actor-agent .actor-id')).toHaveText('reference_agent');
  await expect(stamps.nth(0).locator('time')).toHaveText('last week');
  await expect(stamps.nth(1).locator('.actor-human .actor-id')).toHaveText('dan');
  await expect(stamps.nth(1).locator('time')).toHaveText('3 days ago');
  await expect(popover.getByTestId('meta-popover-sources')).toContainText('2 sources');

  // view ↓ brings the Sources section into view.
  await popover.getByTestId('meta-view-sources').click();
  await expect(page.getByTestId('rendered').locator('section.sources')).toBeInViewport();

  // Escape closes it (the reader has no App Escape peel).
  await pill.hover();
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
});

test('Sources entries show their signals on one line, times relative', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.goto('/cited');
  const entry = page.getByTestId('rendered').locator('section.sources li').nth(0);
  const signals = entry.locator('.source-signal');
  await expect(signals).toHaveText(['persondan', 'modified last month', '1,280× used in September 2026']);
  const modified = entry.locator('time.fm-time');
  await expect(modified).toHaveAttribute('datetime', '2026-05-30T00:00:00Z');
  await expect(modified).toHaveAttribute('title', /2026/);
});

test('the print view keeps a static trust line under the title', async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  await page.goto(`/?print=${encodeURIComponent('cited.md')}`);
  const body = page.getByTestId('print-body');
  await expect(body.locator('h1')).toContainText('Cited Concept');
  const line = body.getByTestId('trust');
  await expect(line.locator('.trust-tier')).toHaveText('Human-reviewed');
  await expect(line.locator('.trust-generated time')).toHaveText('2026-06-20');
  // Directly under the title.
  await expect(body.locator('h1 + [data-testid="trust"]')).toHaveCount(1);
});
