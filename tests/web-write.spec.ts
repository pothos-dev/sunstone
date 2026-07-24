import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import { WEB_BUNDLE_DIR, TEST_AUTH_NAME, TEST_AUTH_EMAIL } from './web-bundle';
import { mountShell, openFromTree, cmContent, headCommit, commitCount, typeAtEnd } from './web-shell';

/**
 * Web WRITE happy path over the REAL chain, reworked for the full-App shell
 * (branch `feat/enable-web-writing`). The ticket-06 `web-edit-toggle` no longer
 * fires for an authed user — they get the whole `App.svelte` shell immediately —
 * so this drives the new flow: sign in → `web-app-shell` mounts → open a scratch
 * Concept from the tree → edit its CodeMirror buffer → EXPLICIT Save (Cmd/Ctrl+S
 * and the `web-save` button) → the SvelteKit hook mints a JWT from the live
 * session → axum verifies it → `sunstone-server` write-then-commits into the
 * served fixture git repo. We assert the `web-save` affordance, then a real
 * commit authored by the signed-in identity.
 *
 * Persistence is EXPLICIT-ONLY on web: a separate case proves that blurring the
 * editor (which auto-commits on desktop) lands NO commit here.
 *
 * A dedicated scratch Concept is written into the SERVED Bundle copy (the temp
 * git repo global-setup built — NOT the in-repo fixture), so this spec never
 * mutates the Concepts the read-only `web-viewer` spec asserts on.
 */
const TARGET_REL = 'edit-target.md';
const TARGET_ABS = join(WEB_BUNDLE_DIR, TARGET_REL);
const TARGET_BODY = `---
type: concept
title: Edit Target
---

# Edit Target

Original body line.
`;

/** Body for a per-test scratch Concept (each test uses its own to stay isolated
 *  — a single edit→Save cycle avoids racing the SSE echo of its own write). */
function bodyFor(title: string): string {
  return `---\ntype: concept\ntitle: ${title}\n---\n\n# ${title}\n\nOriginal body line.\n`;
}

test('unauthenticated visit mounts no app shell and cannot write (401)', async ({ page }) => {
  // No session: reach the unauthed branch by simply not signing in.
  await page.context().clearCookies();
  await page.goto('/good');
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Good Concept');

  // The full App shell (and any CodeMirror write surface) is authed-only.
  await expect(page.getByTestId('web-app-shell')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toHaveCount(0);

  // The `/api` write proxy is the enforcement chokepoint: a write with no
  // session is rejected 401 (the JWT is never minted, axum never sees it).
  const res = await page.request.put('/api/concept', {
    data: { path: TARGET_REL, content: TARGET_BODY },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(401);
});

test('authed Cmd/Ctrl+S edits a Concept and lands a real commit as the signed-in user', async ({
  page,
}) => {
  const rel = 'edit-ctrls.md';
  const abs = join(WEB_BUNDLE_DIR, rel);
  writeFileSync(abs, bodyFor('Edit CtrlS'));
  const marker = `WEBWRITE_S_${Date.now()}`;

  try {
    await mountShell(page, '/');

    // Open the scratch Concept from the interactive tree; its CM buffer shows
    // the BODY (frontmatter is split into the Properties panel).
    const content = await openFromTree(page, rel);
    await expect(content).toContainText('Original body line');

    await typeAtEnd(page, content, `\n\n${marker}`);
    // Editing marks the buffer dirty: the header Save button appears (its
    // presence IS the dirty indicator).
    await expect(page.getByTestId('web-save')).toBeVisible();

    const before = headCommit().hash;
    await page.keyboard.press('Control+s');

    // Save clears the dirty state once the flush resolves (the button
    // disappears), and a NEW commit lands, authored by the signed-in test
    // identity, with the expected subject.
    await expect(page.getByTestId('web-save')).toHaveCount(0);
    await expect.poll(() => headCommit().hash, { timeout: 10_000 }).not.toBe(before);
    const head = headCommit();
    expect(head.subject).toBe(`edit ${rel} via web`);
    expect(head.name).toBe(TEST_AUTH_NAME);
    expect(head.email).toBe(TEST_AUTH_EMAIL);
    expect(readFileSync(abs, 'utf8')).toContain(marker);
  } finally {
    rmSync(abs, { force: true });
  }
});

test('the `web-save` button also persists an explicit commit', async ({ page }) => {
  const rel = 'edit-button.md';
  const abs = join(WEB_BUNDLE_DIR, rel);
  writeFileSync(abs, bodyFor('Edit Button'));
  const marker = `WEBWRITE_BTN_${Date.now()}`;

  try {
    await mountShell(page, '/');
    const content = await openFromTree(page, rel);

    await typeAtEnd(page, content, `\n\n${marker}`);
    await expect(page.getByTestId('web-save')).toBeVisible();

    const before = headCommit().hash;
    await page.getByTestId('web-save').click();

    await expect(page.getByTestId('web-save')).toHaveCount(0);
    await expect.poll(() => headCommit().hash, { timeout: 10_000 }).not.toBe(before);
    const head = headCommit();
    expect(head.subject).toBe(`edit ${rel} via web`);
    expect(head.name).toBe(TEST_AUTH_NAME);
    expect(readFileSync(abs, 'utf8')).toContain(marker);
  } finally {
    rmSync(abs, { force: true });
  }
});

test('web persistence is explicit-only: blurring the editor does NOT commit', async ({ page }) => {
  writeFileSync(TARGET_ABS, TARGET_BODY);
  const marker = `WEBNOBLUR_${Date.now()}`;

  try {
    await mountShell(page, '/');
    const content = await openFromTree(page, TARGET_REL);

    await typeAtEnd(page, content, `\n\n${marker}`);
    await expect(page.getByTestId('web-save')).toBeVisible();

    const before = commitCount();

    // Blur the editor WITHOUT an explicit Save. On desktop the Obsidian-style
    // blur auto-flushes; on web that flush is suppressed (Tile `onBlur` gated on
    // `__SUNSTONE_WEB__`), so no commit may land. Blurring within the same tile
    // (focus the tree pane) avoids a Concept switch (which would gate a save).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.getByTestId('tree').click({ position: { x: 5, y: 5 } });

    // Give any (erroneous) async flush a chance to commit, then prove none did:
    // the buffer stays dirty and the commit count is unchanged.
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('web-save')).toBeVisible();
    expect(commitCount()).toBe(before);
    // Nothing was persisted to disk either.
    expect(readFileSync(TARGET_ABS, 'utf8')).not.toContain(marker);
  } finally {
    rmSync(TARGET_ABS, { force: true });
  }
});
