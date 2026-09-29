import { test, expect } from './fixtures';

/**
 * The anonymous web reader on a phone-sized viewport (`mobileLayout.ts`). Below
 * the breakpoint both Sidebars are slide-over drawers, the rails are hidden and
 * their controls live in the concept strip + an overflow menu. Asserts:
 *   - the Concept gets the full width on first load (no Sidebar squeezing it,
 *     no horizontal page scroll), with the rails gone,
 *   - ☰ opens the Explorer drawer; opening a Concept from it closes the drawer,
 *   - ≡ opens the Outline & Backlinks drawer; the scrim closes it,
 *   - the ⋯ menu toggles Properties and closes on Escape.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('phone layout gives the Concept the full width and uses drawers', async ({ page }) => {
  await page.goto('/');
  const rendered = page.getByTestId('rendered');
  await expect(rendered.locator('h1')).toContainText('Web Bundle Home');

  // Full-width reader, no rails, no sideways scroll.
  const reader = page.getByRole('main', { name: 'Concept' });
  const box = await reader.boundingBox();
  expect(box!.width).toBeGreaterThan(380);
  await expect(page.getByTestId('activity-rail')).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);

  // Both drawers start closed, whatever the (desktop) persisted Sidebar state.
  const left = page.getByTestId('left-side-bar');
  const right = page.getByTestId('right-side-bar');
  await expect(left).toBeHidden();
  await expect(right).toBeHidden();

  // Gate on hydration before tapping: the Tags Section renders from a
  // client-side fetch in the same cycle that wires the click handlers (it sits
  // in the closed drawer, so attached — not visible).
  await expect(page.getByTestId('tag-browser')).toBeAttached();

  // ☰ → Explorer drawer; opening a Concept navigates and closes it.
  await page.getByTestId('drawer-toggle-left').tap();
  await expect(left).toBeVisible();
  await expect(page.getByTestId('drawer-scrim')).toBeVisible();
  await left.locator('[data-testid="tree-concept"][data-path="good.md"]').tap();
  await expect(rendered.locator('h1')).toContainText('Good Concept');
  await expect(left).toBeHidden();
  await expect(page.getByTestId('drawer-scrim')).toHaveCount(0);

  // ≡ → Outline & Backlinks drawer; tapping the scrim closes it.
  await page.getByTestId('drawer-toggle-right').tap();
  await expect(right).toBeVisible();
  await expect(right.getByTestId('outline')).toContainText('Details');
  await page.getByTestId('drawer-scrim').tap({ position: { x: 20, y: 400 } });
  await expect(right).toBeHidden();

  // ⋯ menu: Properties toggle, Escape closes the menu.
  await expect(page.getByTestId('properties')).toBeVisible();
  await page.getByTestId('strip-menu').tap();
  await page.getByTestId('menu-properties').tap();
  await expect(page.getByTestId('properties')).toHaveCount(0);
  await page.getByTestId('strip-menu').tap();
  await expect(page.getByTestId('strip-menu-list')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('strip-menu-list')).toHaveCount(0);

  await page.screenshot({ path: 'tests/screenshots/web-mobile-layout.png' });
});
