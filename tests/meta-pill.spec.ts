import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * ov-24: the Concept metadata pill. Trust (ov-9), lifecycle (ov-11) and the
 * sources count sit next to the title in the Tile header as one segmented
 * pill; hovering it for half a second opens one popover with the detail
 * (Trust / Lifecycle / Sources), times relative with the absolute time on
 * hover. There is no trust line above the body any more. The pill follows the
 * YAML as it is edited, and nothing derived is written to the file. Driven
 * against the fake backend, with the page clock pinned so relative times are
 * stable.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

const PROBE = 'trust-probe.md';
const NOW = new Date('2026-06-28T09:00:00Z');

async function openProbe(page: Page, content: string) {
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate(
    ([p, c]) => (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('created', p, c),
    [PROBE, content] as const,
  );
  await tree.locator(`[data-path="${PROBE}"]`).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Trust probe body.');
  return editor;
}

const FULL =
  '---\ntype: x\ngenerated: { by: acme/agent/1.2, at: 2026-06-20T22:53:05Z }\n' +
  'verified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }\n' +
  'status: stable\nstale_after: 2026-06-01T00:00:00Z\n' +
  'sources:\n  - resource: https://a.example\n  - resource: https://b.example\n  - resource: https://c.example\n' +
  '---\n\nTrust probe body.\n';

test('pill: tier, sources and stale segments; no trust line in the body', async ({ page }) => {
  const editor = await openProbe(page, FULL);
  const pill = page.getByTestId('tile-header').getByTestId('meta-pill');
  await expect(pill.getByTestId('meta-pill-trust')).toHaveText('Reviewed');
  await expect(pill.getByTestId('meta-pill-trust')).toHaveAttribute('data-tier', 'humanReviewed');
  await expect(pill.getByTestId('meta-pill-sources')).toHaveText('3');
  await expect(pill.getByTestId('meta-pill-lifecycle')).toHaveText('stale');
  // The trust line is gone from the body; the lifecycle chips left the header.
  await expect(editor.getByTestId('trust')).toHaveCount(0);
  await expect(page.getByTestId('tile-header').getByTestId('lifecycle')).toHaveCount(0);
});

test('popover: opens after the hover delay with Trust, Lifecycle and Sources', async ({ page }) => {
  await openProbe(page, FULL);
  const pill = page.getByTestId('meta-pill');
  const popover = page.getByTestId('meta-popover');
  await pill.hover();
  // Not at once: the hover must dwell (500 ms).
  await page.waitForTimeout(250);
  await expect(popover).toHaveCount(0);
  await expect(popover).toBeVisible();

  const trust = popover.getByTestId('meta-popover-trust');
  await expect(trust.locator('.mp-tier')).toHaveText('Human-reviewed');
  const [gen, ver] = [trust.getByTestId('meta-popover-stamp').nth(0), trust.getByTestId('meta-popover-stamp').nth(1)];
  await expect(gen.locator('.mp-label')).toHaveText('Generated');
  await expect(gen.locator('.actor-agent .actor-id')).toHaveText('acme/agent');
  await expect(gen.locator('.actor-agent .actor-version')).toHaveText('1.2');
  await expect(gen.locator('time')).toHaveText('last week');
  await expect(gen.locator('time')).toHaveAttribute('datetime', '2026-06-20T22:53:05Z');
  await expect(gen.locator('time')).toHaveAttribute('title', /2026/);
  await expect(ver.locator('.mp-label')).toHaveText('Verified');
  await expect(ver.locator('.actor-human .actor-id')).toHaveText('ahormati');
  await expect(ver.locator('time')).toHaveText('3 days ago');

  const lifecycle = popover.getByTestId('meta-popover-lifecycle');
  await expect(lifecycle).toContainText('Status');
  await expect(lifecycle.locator('.mp-status')).toHaveText('stable');
  await expect(lifecycle).toContainText('Stale since');
  await expect(lifecycle.locator('time')).toHaveText('4 weeks ago');

  await expect(popover.getByTestId('meta-popover-sources')).toContainText('3 sources');

  await page.screenshot({ path: 'tests/screenshots/meta-pill-popover.png' });

  // It stays open while the pointer is over it, and closes on leave.
  await popover.hover();
  await page.waitForTimeout(400);
  await expect(popover).toBeVisible();
  await page.mouse.move(5, 600);
  await expect(popover).toHaveCount(0);
});

test('popover: Escape closes it; keyboard focus opens it; view ↓ jumps to the Sources', async ({ page }) => {
  const editor = await openProbe(page, FULL);
  const pill = page.getByTestId('meta-pill');
  const popover = page.getByTestId('meta-popover');
  await pill.hover();
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);

  // Keyboard focus opens it at once.
  await page.mouse.move(5, 600);
  await pill.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(popover).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);

  await pill.hover();
  await popover.getByTestId('meta-view-sources').click();
  await expect(popover).toHaveCount(0);
  await expect(editor.getByTestId('sources-section')).toBeInViewport();
});

test('pill: adding and removing a verification event re-derives the tier', async ({ page }) => {
  const content =
    '---\ntype: x\ngenerated: { by: acme/agent/1.2, at: 2026-06-20T22:53:05Z }\n---\n\nTrust probe body.\n';
  await openProbe(page, content);
  const tier = page.getByTestId('meta-pill-trust');
  await expect(tier).toHaveText('Unverified');

  await page.getByTestId('frontmatter-toggle').click();
  await page.getByTestId('edit-toggle').click();
  const yaml = page.getByTestId('frontmatter').locator('.cm-content');
  await expect(yaml).toContainText('generated:');
  await yaml.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nverified: [{ by: process:nightly, at: 2026-06-26T02:00:00Z }]');
  await expect(tier).toHaveText('Confirmed');

  // A person's sign-off lifts it; taking it out drops it again.
  const human = ', { by: human:ahormati, at: 2026-06-25T09:00:00Z }';
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type(human);
  await expect(tier).toHaveText('Reviewed');
  for (const _ of human) await page.keyboard.press('Backspace');
  await expect(tier).toHaveText('Confirmed');

  // Only the YAML is written: the tier is derived, never stored.
  await expect
    .poll(() => page.evaluate((p) => (window as unknown as FakeWindow).__sunstoneFake.files[p], PROBE))
    .toContain('verified: [{ by: process:nightly, at: 2026-06-26T02:00:00Z }]');
  const saved = await page.evaluate((p) => (window as unknown as FakeWindow).__sunstoneFake.files[p], PROBE);
  expect(saved).not.toMatch(/tier|Machine-confirmed|Confirmed/i);
});

test('popover: a generated block without by degrades visibly; a non-ISO time is as written', async ({ page }) => {
  await openProbe(page, '---\ntype: x\ngenerated:\n  at: 2026-06-20\n---\n\nTrust probe body.\n');
  await expect(page.getByTestId('meta-pill-trust')).toHaveText('Unverified');
  await page.getByTestId('meta-pill').hover();
  const gen = page.getByTestId('meta-popover').getByTestId('meta-popover-stamp');
  await expect(gen.locator('.mp-missing')).toHaveText('unknown');
  await expect(gen.locator('.mp-at')).toHaveText('2026-06-20');
});

test('pill: a legacy timestamp alone, or no keys, shows no pill', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  const editor = page.getByTestId('editor');

  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(editor).toContainText('CodeMirror 6 is the editor core.');
  await expect(page.getByTestId('meta-pill')).toHaveCount(0);
  await expect(editor.getByTestId('trust')).toHaveCount(0);

  await tree.locator('[data-path="concepts/bundle.md"]').click();
  await expect(editor).toContainText('Bundle');
  await expect(page.getByTestId('meta-pill')).toHaveCount(0);
});
