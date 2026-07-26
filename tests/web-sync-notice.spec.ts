import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures';
import type { Page } from './fixtures';
import { WEB_BUNDLE_DIR } from './web-bundle';
import { mountShell, openFromTree } from './web-shell';

/**
 * The git sync loop's DIVERGENCE NOTICES on the web editor surface (git-sync
 * spec §10.2–§10.4).
 *
 * Two events reach users, both broadcast to every client and worded
 * impersonally: a conflicting web version was `forked` beside the canonical
 * file, or a web deletion was dropped (`deletionDropped`) because origin had
 * modified the file. They render in the SAME notice slot as "Updated on disk"
 * but with the opposite lifetime: **dismissible, never auto-dismissed**, because
 * the whole payload of a `forked` notice is a filename to remember. This spec
 * asserts that contrast against the LIVE 4-second auto-dismiss, in one timeline
 * (test 2), so "it stayed" cannot be a sleep that happens to be long enough.
 *
 * ## Why this spec lives in the WEB suite, and how the notice is driven
 *
 * The notice surface is `WebConcurrencyModals`, used ONLY by the two editor
 * islands (`WebAppShellIsland` here, since a signed-in web user gets the full App
 * shell) — and the islands only exist in the SSR web build, where the seam is
 * `http.ts`. So the desktop suite's `window.__sunstoneFake.simulateSyncNotice`
 * cannot reach this UI: in the desktop build there is no island to render it, and
 * in the web build the selected backend is `httpBackend`, not the fake. See
 * `review-toggle.spec.ts`'s last test for the desktop half (the seam is a no-op
 * there and NO notice UI exists).
 *
 * The stimulus therefore has to arrive the way production delivers it: a named
 * `sync` event on the ONE shared `/api/events` EventSource (§10.3). Only a
 * git-SYNCED deployment's loop emits those, and the web e2e server is a plain
 * fixture repo with no origin — so `observeEventSources` SUBCLASSES
 * `window.EventSource` before any page script runs, keeping the real connection
 * (nothing is stubbed: real URL, real `message` traffic, real watcher-driven
 * "Updated on disk" in test 2) and merely keeping a handle on the instance.
 * `driveSyncNotice` then dispatches a real `MessageEvent('sync')` on it, so the
 * assertion path runs the production client code end to end: `http.ts`'s
 * `addEventListener('sync', …)` → `parseSyncNotice` → the island's queue →
 * `syncNoticeText` → the rendered, dismissible row.
 */

type SyncNotice =
  | { kind: 'forked'; path: string; fork: string }
  | { kind: 'deletionDropped'; path: string };

type SseWindow = Window & { __sunstoneTestSse?: EventSource[] };

/** Delay covering the island's EventSource subscribe (mirrors web-concurrency). */
const SSE_SETTLE_MS = 1500;

/**
 * Observe every `EventSource` the page opens, without replacing the transport:
 * the subclass calls `super(...)`, so the real `/api/events` connection is made
 * and every real event still arrives. Must run before the page's scripts, hence
 * `addInitScript` in a `beforeEach`.
 */
async function observeEventSources(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Real = window.EventSource;
    class ObservedEventSource extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        const w = window as SseWindow;
        (w.__sunstoneTestSse ??= []).push(this);
      }
    }
    window.EventSource = ObservedEventSource as unknown as typeof EventSource;
  });
}

/**
 * Deliver one `SyncNotice` as the server's named `sync` SSE event. Waits for a
 * live EventSource first: its existence means the island's `onMount` ran (that is
 * where both seam subscriptions are registered), and it makes a vacuous pass
 * impossible — a page with nothing to dispatch on fails here rather than
 * "correctly" showing no notice.
 */
async function driveSyncNotice(page: Page, notice: SyncNotice): Promise<void> {
  await page.waitForFunction(() => ((window as SseWindow).__sunstoneTestSse?.length ?? 0) > 0, {
    timeout: 15_000,
  });
  await page.evaluate((payload) => {
    for (const source of (window as SseWindow).__sunstoneTestSse ?? []) {
      source.dispatchEvent(new MessageEvent('sync', { data: JSON.stringify(payload) }));
    }
  }, notice);
}

function scratchBody(title: string, body: string): string {
  return `---\ntype: concept\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;
}

const noticeRows = (page: Page): Locator => page.getByTestId('web-sync-notice');
const dismissButtons = (page: Page): Locator => page.getByTestId('web-sync-notice-dismiss');

test.beforeEach(async ({ page }) => {
  await observeEventSources(page);
});

test('a forked notice names the fork as plain text and stays until dismissed', async ({ page }) => {
  await mountShell(page, '/good');

  await driveSyncNotice(page, {
    kind: 'forked',
    path: 'good.md',
    fork: 'good-20260726T101500Z.md',
  });

  // The queue container + exactly one row, carrying §10.2's impersonal copy with
  // BOTH paths (never "your edit").
  await expect(page.getByTestId('web-sync-notices')).toBeVisible();
  await expect(noticeRows(page)).toHaveCount(1);
  const row = noticeRows(page).first();
  await expect(row).toContainText('A conflicting copy of good.md was saved as');
  await expect(row).toContainText('good-20260726T101500Z.md');
  await expect(row).not.toContainText('your');

  // §10.4: the fork path is PLAIN TEXT, not a link — naming it is enough to
  // reach it via Ctrl+K, and linking it starts a reconciliation UX that is out
  // of scope. No anchor, and nothing clickable-to-navigate, in the row.
  await expect(row.locator('a')).toHaveCount(0);
  await expect(row.locator('[data-path]')).toHaveCount(0);

  await page.screenshot({ path: 'tests/screenshots/web-sync-notice.png' });

  // One dismiss affordance, labelled for assistive tech, and it clears the row.
  const dismiss = row.getByTestId('web-sync-notice-dismiss');
  await expect(dismiss).toHaveAttribute('aria-label', 'Dismiss notice');
  await dismiss.click();
  await expect(noticeRows(page)).toHaveCount(0);
  await expect(page.getByTestId('web-sync-notices')).toHaveCount(0);
});

test('the 4s auto-dismiss still clears "Updated on disk" but NEVER a sync notice', async ({
  page,
}) => {
  // THE contrast, in ONE timeline (§10.4). Order matters and is the whole proof:
  //   1. the sync notice is driven FIRST;
  //   2. a real external write then raises the auto-dismissing "Updated on disk"
  //      notice (real watcher → real SSE → the island's clean-buffer branch);
  //   3. waiting for THAT notice to disappear is what establishes that the 4s
  //      window has fully elapsed — a live behavioural clock, not a
  //      `waitForTimeout` guess — and it proves auto-dismiss still works;
  //   4. at that instant the sync notice must STILL be on screen, and only a
  //      click on its dismiss button may remove it.
  const rel = 'sync-notice-target.md';
  const abs = join(WEB_BUNDLE_DIR, rel);
  writeFileSync(abs, scratchBody('Sync Notice Target', 'Original clean body.'));

  try {
    await mountShell(page, '/');
    // Open it so the external write below lands on the ACTIVE (clean) buffer —
    // the branch that raises the auto-dismissing "updated" notice (the same setup
    // `web-concurrency.spec.ts` uses for it).
    await openFromTree(page, rel);
    // A broadcast only reaches already-connected subscribers; settle briefly.
    await page.waitForTimeout(SSE_SETTLE_MS);

    // (1) The dismissible notice.
    await driveSyncNotice(page, {
      kind: 'forked',
      path: rel,
      fork: 'sync-notice-target-20260726T101500Z.md',
    });
    await expect(noticeRows(page)).toHaveCount(1);

    // (2) The auto-dismissing notice, over the real watcher path.
    writeFileSync(abs, scratchBody('Sync Notice Target', 'EXTERNALLY_RELOADED body.'));
    const updated = page.getByTestId('web-updated-notice');
    await expect(updated).toBeVisible({ timeout: 15_000 });
    // Both kinds coexist in the slot — the sync notice is not replaced by it.
    await expect(noticeRows(page)).toHaveCount(1);

    // (3) "Updated on disk" auto-dismisses (4s timeout unchanged by this work).
    await expect(updated).toHaveCount(0, { timeout: 15_000 });

    // (4) The sync notice outlived that whole window and is still legible.
    await expect(noticeRows(page)).toHaveCount(1);
    await expect(noticeRows(page).first()).toContainText('sync-notice-target-20260726T101500Z.md');
    // Nothing else has cleared it after a further stretch well past 4s either.
    await page.waitForTimeout(5_000);
    await expect(noticeRows(page)).toHaveCount(1);

    // Only the dismiss button removes it.
    await dismissButtons(page).first().click();
    await expect(noticeRows(page)).toHaveCount(0);
  } finally {
    rmSync(abs, { force: true });
  }
});

test('a deletionDropped notice renders its own copy and is dismissible', async ({ page }) => {
  await mountShell(page, '/good');

  await driveSyncNotice(page, { kind: 'deletionDropped', path: 'guide/topic.md' });

  const row = noticeRows(page).first();
  await expect(row).toBeVisible();
  await expect(noticeRows(page)).toHaveCount(1);
  // §10.2's second wording: the deletion was reverted BECAUSE origin modified the
  // file — a different sentence from the fork notice, not a shared generic one.
  await expect(row).toContainText('Deletion of guide/topic.md was reverted');
  await expect(row).toContainText('modified on origin');
  await expect(row).not.toContainText('conflicting copy');

  await row.getByTestId('web-sync-notice-dismiss').click();
  await expect(noticeRows(page)).toHaveCount(0);
});

test('two notices QUEUE rather than replace, and dismiss one at a time', async ({ page }) => {
  await mountShell(page, '/good');

  // A second notice must never swallow the first's filename (§10.4: queued, not
  // latest-wins) — that path is the entire actionable payload.
  await driveSyncNotice(page, { kind: 'forked', path: 'good.md', fork: 'good-A.md' });
  await expect(noticeRows(page)).toHaveCount(1);
  await driveSyncNotice(page, { kind: 'deletionDropped', path: 'guide/topic.md' });

  await expect(noticeRows(page)).toHaveCount(2);
  await expect(dismissButtons(page)).toHaveCount(2);
  const rows = noticeRows(page);
  // Arrival order, oldest first.
  await expect(rows.nth(0)).toContainText('good-A.md');
  await expect(rows.nth(1)).toContainText('Deletion of guide/topic.md was reverted');

  // Dismissing the FIRST leaves the SECOND intact (per-notice dismissal, not a
  // "clear all" affordance).
  await rows.nth(0).getByTestId('web-sync-notice-dismiss').click();
  await expect(noticeRows(page)).toHaveCount(1);
  await expect(noticeRows(page).first()).toContainText('Deletion of guide/topic.md was reverted');
  await expect(noticeRows(page).first()).not.toContainText('good-A.md');

  // A third notice still appends while one is pending.
  await driveSyncNotice(page, { kind: 'forked', path: 'index.md', fork: 'index-B.md' });
  await expect(noticeRows(page)).toHaveCount(2);
  await expect(noticeRows(page).nth(1)).toContainText('index-B.md');
});

test('no sync notice ever renders on the anonymous viewer surface', async ({ page }) => {
  // §10.4: editor islands ONLY. A pure reader has no stake in either event, and
  // `WebViewer` deliberately has no notice slot — even though it holds a live
  // `/api/events` connection of its own (live reload), which is what the dispatch
  // below rides. `driveSyncNotice` fails if that connection is absent, so this
  // cannot pass vacuously.
  await page.context().clearCookies();
  await page.goto('/good');
  await expect(page.getByTestId('web-viewer')).toBeVisible();
  await expect(page.getByTestId('web-app-shell')).toHaveCount(0);
  await page.waitForTimeout(SSE_SETTLE_MS);

  await driveSyncNotice(page, {
    kind: 'forked',
    path: 'good.md',
    fork: 'good-20260726T101500Z.md',
  });
  await driveSyncNotice(page, { kind: 'deletionDropped', path: 'good.md' });

  await expect(page.getByTestId('web-sync-notices')).toHaveCount(0);
  await expect(noticeRows(page)).toHaveCount(0);
  await expect(dismissButtons(page)).toHaveCount(0);
  // The read surface is otherwise untouched (no stray fork filename anywhere).
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Good Concept');
  await expect(page.locator('body')).not.toContainText('20260726T101500Z');
});
