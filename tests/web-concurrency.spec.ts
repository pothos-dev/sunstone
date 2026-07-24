import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures';
import type { Page } from './fixtures';
import { WEB_BUNDLE_DIR } from './web-bundle';
import { mountShell, openFromTree, typeAtEnd } from './web-shell';

/**
 * Web CONCURRENCY UX over REAL SSE, reworked for the full-App shell (branch
 * `feat/enable-web-writing`; ticket 08). A test-authed user is editing a Concept
 * in the mounted `App.svelte` shell when a SECOND writer changes that same file
 * on disk. The running `sunstone-server` watcher broadcasts a `FileChange` over
 * `/api/events`; `WebAppShellIsland` — the SINGLE web `onFileChanged` handler —
 * routes the active buffer by the ticket-08 rules: clean buffer → silent reload
 * + a non-blocking `web-updated-notice`; dirty buffer → the blocking
 * `web-conflict-modal`; an external delete of a dirty active Concept →
 * `web-deleted-state`.
 *
 * The "second writer" is a plain filesystem write to the SERVED Bundle copy (the
 * temp git repo global-setup built), exactly as `web-viewer.spec.ts` drives
 * live-reload. A bare fs write carries `origin: null` (no `clientId`), so the
 * client can never mistake it for its own echo (`isOwnEcho` is false) — the
 * right stimulus for all branches. Each test uses its OWN scratch Concept.
 */

/** Delay covering the island's EventSource subscribe (mirrors web-viewer). */
const SSE_SETTLE_MS = 1500;

/**
 * Sign in, write a scratch Concept into the served Bundle, mount the App shell,
 * open it from the tree, and let the island's SSE subscription settle. Returns
 * the live CM content locator + the scratch path. Caller `rmSync`s in `finally`.
 */
async function openScratch(page: Page, rel: string, body: string): Promise<{
  content: Locator;
  abs: string;
}> {
  const abs = join(WEB_BUNDLE_DIR, rel);
  writeFileSync(abs, body);

  await mountShell(page, '/');
  const content = await openFromTree(page, rel);

  // A broadcast only reaches already-connected subscribers; there is no DOM
  // signal for "SSE open", so settle briefly (as in web-viewer's reload test).
  await page.waitForTimeout(SSE_SETTLE_MS);
  return { content, abs };
}

function scratchBody(title: string, body: string): string {
  return `---\ntype: concept\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;
}

test('clean buffer: an external change silently reloads + shows the updated notice', async ({
  page,
}) => {
  const rel = 'reload-target.md';
  const { content, abs } = await openScratch(
    page,
    rel,
    scratchBody('Reload Target', 'Original clean body.'),
  );
  try {
    // Second writer changes the active file; the buffer is CLEAN → silent reload.
    writeFileSync(abs, scratchBody('Reload Target', 'EXTERNALLY_RELOADED body.'));

    await expect(page.getByTestId('web-updated-notice')).toBeVisible({ timeout: 15_000 });
    // The buffer reloaded from disk to the new content (no conflict modal).
    await expect(content).toContainText('EXTERNALLY_RELOADED', { timeout: 15_000 });
    await expect(page.getByTestId('web-conflict-modal')).toHaveCount(0);
    // Reloaded from disk → still clean (no dirty dot).
    await expect(page.getByTestId('web-save')).toHaveCount(0);
  } finally {
    rmSync(abs, { force: true });
  }
});

test('dirty buffer: an external change raises the conflict modal; discard reloads clean', async ({
  page,
}) => {
  const rel = 'conflict-target.md';
  const { content, abs } = await openScratch(
    page,
    rel,
    scratchBody('Conflict Target', 'Original body.'),
  );
  try {
    // Make the buffer dirty with local edits.
    await typeAtEnd(page, content, '\n\nLOCAL_UNSAVED_EDIT');
    await expect(page.getByTestId('web-save')).toBeVisible();

    // Second writer changes the SAME active file → blocking conflict modal.
    writeFileSync(abs, scratchBody('Conflict Target', 'THEIR_NEWER_VERSION body.'));
    const modal = page.getByTestId('web-conflict-modal');
    await expect(modal).toBeVisible({ timeout: 15_000 });

    // "Discard my changes & reload" drops local edits + loads their version clean.
    await page.getByTestId('web-conflict-discard').click();
    await expect(modal).toHaveCount(0);
    await expect(content).toContainText('THEIR_NEWER_VERSION');
    await expect(content).not.toContainText('LOCAL_UNSAVED_EDIT');
    // Buffer is clean again → no dirty dot.
    await expect(page.getByTestId('web-save')).toHaveCount(0);
  } finally {
    rmSync(abs, { force: true });
  }
});

test('dirty buffer: "keep my changes" dismisses the conflict and stays dirty', async ({ page }) => {
  const rel = 'keep-target.md';
  const { content, abs } = await openScratch(
    page,
    rel,
    scratchBody('Keep Target', 'Original body.'),
  );
  try {
    await typeAtEnd(page, content, '\n\nKEEP_MY_EDIT');
    await expect(page.getByTestId('web-save')).toBeVisible();

    writeFileSync(abs, scratchBody('Keep Target', 'THEIR_VERSION body.'));
    const modal = page.getByTestId('web-conflict-modal');
    await expect(modal).toBeVisible({ timeout: 15_000 });

    // "Keep my changes" dismisses the modal; the local buffer stays dirty and
    // still holds the unsaved edit (a later Save would win last-write-wins).
    await page.getByTestId('web-conflict-keep').click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('web-save')).toBeVisible();
    await expect(content).toContainText('KEEP_MY_EDIT');
  } finally {
    rmSync(abs, { force: true });
  }
});

test('dirty buffer: an external delete of the active Concept shows the deleted state', async ({
  page,
}) => {
  const rel = 'delete-target.md';
  const { content, abs } = await openScratch(
    page,
    rel,
    scratchBody('Delete Target', 'Original body.'),
  );
  try {
    // Dirty the buffer so the delete becomes a recoverable "orphan" (not a
    // silent drop-back to empty, which is the clean-buffer behaviour).
    await typeAtEnd(page, content, '\n\nUNSAVED_BEFORE_DELETE');
    await expect(page.getByTestId('web-save')).toBeVisible();

    // Second writer deletes the active file on disk → deleted-state banner.
    rmSync(abs, { force: true });
    await expect(page.getByTestId('web-deleted-state')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('web-deleted-save')).toBeVisible();
    await expect(page.getByTestId('web-deleted-discard')).toBeVisible();
  } finally {
    rmSync(abs, { force: true });
  }
});
