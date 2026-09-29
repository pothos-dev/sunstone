import { test, expect } from './fixtures';

/**
 * Closing the app must not drop debounced work (the Backend `onBeforeClose`
 * seam): a scheduled autosave (300 ms) and a scheduled session-state write
 * (250 ms) are flushed instead of dying with their timers.
 *
 * Both checks run INSIDE the debounce window, so only the flush — never the
 * timer — can have written what they assert.
 */

type Fake = {
  __sunstoneFake: { files: Record<string, string>; simulateCloseRequest(): Promise<void> };
};

test('a close request writes the autosave still inside its debounce window', async ({ page }) => {
  const path = 'concepts/codemirror.md';
  await page.goto('/');
  await page.getByTestId('tree').locator(`[data-path="${path}"]`).click();
  await page.getByTestId('edit-toggle').click();
  const body = page.getByTestId('editor').locator('.cm-content');
  await body.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' CLOSE_FLUSH');

  // Read the fake's disk in the same task as the close request: no timer can
  // fire in between, so a hit can only come from the flush.
  const [before, after] = await page.evaluate(async (p) => {
    const fake = (window as unknown as Fake).__sunstoneFake;
    const before = fake.files[p];
    await fake.simulateCloseRequest();
    return [before, fake.files[p]];
  }, path);
  expect(before).not.toContain('CLOSE_FLUSH');
  expect(after).toContain('CLOSE_FLUSH');
});

test('a close request writes the session change still inside its debounce window', async ({
  page,
}) => {
  await page.goto('/');
  const toggle = page.getByTestId('rail-toggle-right');
  await expect(toggle).toBeVisible();
  // Let restore's own session write settle, so what we read below is ours.
  await page.waitForTimeout(400);
  const flipped = (await toggle.getAttribute('aria-pressed')) === 'true' ? false : true;

  await toggle.click();
  const [before, after] = await page.evaluate(async () => {
    const fake = (window as unknown as Fake).__sunstoneFake;
    const read = () =>
      (JSON.parse(localStorage.getItem('sunstone:bundleState:/fake/bundle') ?? '{}') as {
        rightSidebarOpen?: boolean;
      }).rightSidebarOpen;
    const before = read();
    await fake.simulateCloseRequest();
    return [before, read()];
  });
  expect(before).not.toBe(flipped);
  expect(after).toBe(flipped);
});
