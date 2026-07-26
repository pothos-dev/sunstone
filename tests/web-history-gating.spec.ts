import { test, expect } from './fixtures';
import { signOutTestUser } from './web-auth';
import { mountShell, enterEdit } from './web-shell';

/**
 * WEB GIT HISTORY, session-gated (git-sync spec §11).
 *
 * `GET /api/history` and `GET /api/file-at-rev` are the two GETs that take the
 * WRITE chokepoint's session→mint-JWT→forward branch (`hooks.server.ts`'s
 * `GATED_READS`), because `fileAtRev` returns the full text of any path at any
 * revision — including content deliberately DELETED from the Bundle — and the
 * history listing is the index that makes those revisions enumerable. The gate IS
 * the write gate (`src/auth.ts`: authenticated == authorized).
 *
 * Both halves are proven here, on the real stack (real Auth.js session, real
 * mint, real axum `AuthedUser`, real `git log` over the seeded fixture repo):
 *
 *  - ANONYMOUS: no review-diff affordance exists at all (the read surface has no
 *    Tile chrome), and both routes answer 401 WITHOUT leaking file content.
 *  - SIGNED IN: the routes answer with real history, and the shared review-diff
 *    UI in the mounted App shell opens a working-tree ↔ HEAD diff — which also
 *    proves the SECOND gated route (`file-at-rev`), since the diff's old side is
 *    fetched through it.
 *  - The 401 → `gitMissing` FOLD: losing the session downgrades the toggle to
 *    "unavailable capability" (disabled, explanatory tooltip) rather than
 *    surfacing an error, keeping the seam's contract ("only a path escape
 *    rejects") true on the web.
 */

const HISTORY_URL = '/api/history?path=good.md';
const FILE_AT_REV_URL = '/api/file-at-rev?path=good.md&rev=HEAD';

/** The tooltip `reviewAvailability` shows when the toggle IS available. */
const REVIEW_ENABLED_TOOLTIP = 'Review changes since the last commit (HEAD)';

test('anonymous: no review-diff toggle, and the git routes 401 without leaking content', async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto('/good');

  // The anonymous read surface (never the App shell), so there is no Tile header
  // and therefore NO review-diff affordance anywhere on the page.
  await expect(page.getByTestId('web-viewer')).toBeVisible();
  await expect(page.getByTestId('web-app-shell')).toHaveCount(0);
  await expect(page.getByTestId('review-toggle')).toHaveCount(0);
  await expect(page.getByTestId('review-editor')).toHaveCount(0);
  await expect(page.getByTestId('review-stepper')).toHaveCount(0);

  // The two gated routes are refused at the SvelteKit chokepoint (no session →
  // no minted JWT → 401), and — the whole reason they are gated — the response
  // carries none of the file's committed text.
  const request = page.context().request;
  for (const url of [HISTORY_URL, FILE_AT_REV_URL]) {
    const res = await request.get(url);
    expect(res.status(), `${url} must be session-gated`).toBe(401);
    const body = await res.text();
    expect(body).not.toContain('Good Concept');
    expect(body).not.toContain('commits');
  }
});

test('signed in: the gated routes serve real history and the review diff opens', async ({
  page,
}) => {
  await mountShell(page, '/good');

  // The route itself, through the whole chain: session → hook mint → axum
  // `AuthedUser` → `git.rs::file_history` over the seeded fixture repo.
  const res = await page.context().request.get(HISTORY_URL);
  expect(res.status()).toBe(200);
  const history = (await res.json()) as {
    status: string;
    commits?: { hash: string; subject: string }[];
  };
  expect(history.status).toBe('ok');
  expect(history.commits?.length ?? 0).toBeGreaterThan(0);
  expect(history.commits?.at(-1)?.subject).toBe('seed web fixture');

  // `file-at-rev` is gated with it and serves the committed bytes to a session.
  const atRev = await page.context().request.get(FILE_AT_REV_URL);
  expect(atRev.status()).toBe(200);
  const snapshot = (await atRev.json()) as { status: string; content?: string };
  expect(snapshot.status).toBe('ok');
  expect(snapshot.content).toContain('Good Concept');

  // The shared review-diff UI is consequently AVAILABLE (an `ok` history is the
  // only status that enables it) — the frontend components are unchanged, so this
  // is the desktop `review-toggle` behaviour running on web.
  const reviewToggle = page.getByTestId('review-toggle').first();
  await expect(reviewToggle).toBeEnabled({ timeout: 15_000 });
  await expect(reviewToggle).toHaveAttribute('title', REVIEW_ENABLED_TOOLTIP);
  await expect(reviewToggle).toHaveAttribute('aria-pressed', 'false');

  // A working-tree edit so the working ↔ HEAD diff is non-empty, then review on.
  await enterEdit(page);
  const content = page.locator('[data-testid="editor"] .cm-content').first();
  await expect(content).toHaveAttribute('contenteditable', 'true');
  await content.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nA web working-tree paragraph for review.');

  await reviewToggle.click();
  const review = page.getByTestId('review-editor');
  await expect(review).toBeVisible();
  await expect(reviewToggle).toHaveAttribute('aria-pressed', 'true');
  // The diff rendered: the added paragraph is a green CriticMarkup add mark, and
  // the raw delimiters stay hidden. Its OLD side came from `file-at-rev`, so this
  // exercises both gated routes.
  await expect(review.locator('.cm-critic-add').first()).toBeVisible();
  await expect(review).toContainText('A web working-tree paragraph for review.');
  await expect(review).not.toContainText('{++');
  // Read-only, and the history stepper opens at the working-tree pair.
  await expect(review.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByTestId('review-stepper-label')).toHaveText('Working tree ↔ HEAD');

  await page.screenshot({ path: 'tests/screenshots/web-history-gating.png' });

  // Leave review so the test ends on the ordinary editing surface.
  await reviewToggle.click();
  await expect(page.getByTestId('review-editor')).toHaveCount(0);
});

test('losing the session downgrades history to unavailable, not an error', async ({ page }) => {
  await mountShell(page, '/good');
  const reviewToggle = page.getByTestId('review-toggle').first();
  await expect(reviewToggle).toBeEnabled({ timeout: 15_000 });

  // Drop the session cookie (the real `POST /auth/signout`) WITHOUT reloading, so
  // the next history fetch from the still-mounted App shell is the anonymous one.
  await signOutTestUser(page);

  // Switching Concepts re-runs the per-Tile history fetch → 401 at the hook →
  // `http.ts` folds it into `{ status: 'gitMissing' }` → the toggle disables with
  // an explanatory tooltip. No error surface, no thrown seam call (§11's mapping).
  await page.getByTestId('tree').locator('[data-path="critic.md"]').click();
  await expect(reviewToggle).toBeDisabled({ timeout: 15_000 });
  await expect(reviewToggle).toHaveAttribute('title', /unavailable/i);
  await expect(page.getByTestId('review-editor')).toHaveCount(0);
});
