import { test, expect } from './fixtures';
import { signInAsTestUser, signOutTestUser } from './web-auth';
import { mountShell, cmContent, enterEdit } from './web-shell';
import { TEST_AUTH_NAME } from './web-bundle';

/**
 * The full-App WEB SHELL gate (branch `feat/enable-web-writing`, WP0).
 *
 * An ANONYMOUS visitor keeps the SSR read-only `WebViewer` (`web-viewer`); an
 * AUTHENTICATED user instead gets the WHOLE desktop `App.svelte` shell mounted
 * by the client-only `WebAppShellIsland` (`web-app-shell`) — the interactive
 * CRUD tree, the CodeMirror editor, and the sidebars. This spec proves the
 * branch: which surface each identity lands on, that the App shell finishes
 * loading (the `web-app-loading` placeholder clears), and that the real
 * CodeMirror buffer + interactive tree are present.
 */

test('anonymous visitor gets the read-only viewer, never the app shell', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/good');

  // The SSR read surface renders; the interactive App shell does not mount.
  await expect(page.getByTestId('web-viewer')).toBeVisible();
  await expect(page.getByTestId('web-app-shell')).toHaveCount(0);
  await expect(page.getByTestId('web-app-loading')).toHaveCount(0);
  // Rendered (read-only) HTML, not a CodeMirror surface.
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Good Concept');
  await expect(page.locator('.cm-content')).toHaveCount(0);
});

test('authed user gets the full App shell: CodeMirror editor + interactive tree', async ({
  page,
}) => {
  // Land directly on a Concept so App opens it (via `initialConcept`) into the
  // single default Tile — the editor host becomes visible with a live CM buffer.
  await mountShell(page, '/good');

  // The interactive App tree (not the SSR `web-tree`): `data-testid="tree"` with
  // `[data-path]` file rows, and NO read-only `tree-concept` rows.
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  expect(await tree.locator('[data-path]').count()).toBeGreaterThan(0);
  await expect(page.getByTestId('tree-concept')).toHaveCount(0);

  // The real CodeMirror editor is present with the opened Concept; entering
  // edit mode (Concepts open in `read` post-layout-rework) makes it editable.
  const content = cmContent(page);
  await expect(content).toBeVisible();
  await expect(content).toContainText('Good Concept');
  await enterEdit(page);
  await expect(content).toHaveAttribute('contenteditable', 'true');

  // The explicit-Save affordance is mounted (clean buffer → disabled, no dot).
  await expect(page.getByTestId('web-save')).toBeVisible();
  await expect(page.getByTestId('web-save')).toBeDisabled();
  await expect(page.getByTestId('web-dirty')).toHaveCount(0);

  await page.screenshot({ path: 'tests/screenshots/web-app-shell.png', fullPage: true });
});

test('signing in swaps the read surface for the app shell on the same session', async ({
  page,
}) => {
  // Before sign-in: anonymous read surface.
  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.getByTestId('web-viewer')).toBeVisible();
  await expect(page.getByTestId('web-app-shell')).toHaveCount(0);

  // After the real Auth.js sign-in + reload: the full App shell mounts.
  await signInAsTestUser(page);
  await page.goto('/');
  await expect(page.getByTestId('web-app-shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('web-app-loading')).toHaveCount(0);
  await expect(page.getByTestId('web-viewer')).toHaveCount(0);

  // The account bar shows the identity + a one-click sign-out button.
  await expect(page.getByTestId('web-user')).toHaveText(TEST_AUTH_NAME);
  await expect(page.getByTestId('web-sign-out')).toBeVisible();

  // Signing out clears the session (real /auth/signout — driven via the request
  // context for the origin reason in web-auth.ts) and re-lands on the anon read
  // surface after a reload.
  await signOutTestUser(page);
  await page.goto('/');
  await expect(page.getByTestId('web-viewer')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('web-app-shell')).toHaveCount(0);
});
