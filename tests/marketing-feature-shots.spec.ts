import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { mkdirSync } from 'node:fs';

/**
 * Screenshots for the landing page (marketing/assets/). Not a behavioural test:
 * it swaps the fake backend's fixture Bundle for a small, realistic OKF Bundle
 * (a payments team's engineering wiki) and frames one feature per shot:
 *
 *  - hero:       the service Concept with both Sidebars and the trust pill
 *  - fields:     the frontmatter as a grid of fields (read mode)
 *  - okf:        the trust pill popover, and the Explorer marking a draft and a
 *                stale Concept
 *  - footnotes:  footnotes citing frontmatter `sources`, the Sources list and a
 *                source hover card
 *  - annotations: review comments in the margin (CriticMarkup in the file)
 *  - properties: the frontmatter editor flagging a value OKF doesn't allow
 *
 *  - wiki:       the live guide at wiki.sunstone.md (Sunstone Web; needs network)
 *
 * Each in light and dark (theme follows the context's `colorScheme`). The page
 * Dates are relative to now so relative times ("3 days ago") are stable across runs.
 * Run: bunx playwright test tests/marketing-feature-shots.spec.ts
 */

const ASSET_DIR = 'marketing/assets';
/** An ISO timestamp `days` before now. Relative to the real clock, so labels
 *  like "3 days ago" come out the same whenever the shots are regenerated (a
 *  fixed page clock would also stop CodeMirror's lint from ever running). */
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19) + 'Z';

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

const BUNDLE: Record<string, string> = {
  'index.md': `---
okf_version: "0.2"
---

# Payments Engineering

How the payments platform is built and run. Start with the [[ledger-service|Ledger service]].
`,
  'services/ledger-service.md': `---
type: Service
title: Ledger service
description: Double-entry ledger that records every money movement on the platform.
tags: [payments, ledger, tier-1]
owner: team-payments-core
status: stable
generated: { by: claude-code/claude-opus-5-5, at: ${daysAgo(8)} }
verified: { by: human:mkovacs, at: ${daysAgo(3)} }
sources:
  - id: adr-0004
    resource: /decisions/0004-double-entry.md
    title: "ADR 0004: Double-entry bookkeeping"
  - id: pg-docs
    resource: https://www.postgresql.org/docs/current/transaction-iso.html
    title: PostgreSQL transaction isolation
  - id: incident-2291
    resource: /incidents/2291-duplicate-captures.md
    title: "Incident 2291: duplicate captures"
---

# Ledger service

The ledger is the source of truth for balances. Every [[payment-flow|payment]], refund and payout is written as a balanced set of entries: debits equal credits, always.[^adr-0004]

## Writes

Postings run in a single \`SERIALIZABLE\` transaction, so two captures for the same account can't interleave.[^pg-docs] Each request carries an idempotency key; a retry with the same key returns the original posting instead of writing a second one.[^incident-2291]

\`\`\`sql
INSERT INTO entries (posting_id, account_id, amount_minor, currency)
VALUES ($1, $2, $3, $4), ($1, $5, -$3, $4);
\`\`\`

| Endpoint | Purpose | p99 |
|---|---|---|
| \`POST /postings\` | Write a balanced posting | 38 ms |
| \`GET /accounts/:id/balance\` | Current balance | 6 ms |
| \`GET /accounts/:id/entries\` | Entry history, paginated | 21 ms |

## Operations

- [x] Daily reconciliation against the bank statement, see [[ledger-reconciliation|Ledger reconciliation]]
- [x] Alerts on unbalanced postings
- [ ] Partition \`entries\` by month

[^adr-0004]: We chose double-entry over a balance column so every change is auditable.
`,
  'services/payment-flow.md': `---
type: Process
title: Payment flow
description: From checkout to settled funds.
tags: [payments]
status: stable
---

# Payment flow

Checkout creates an intent, the PSP authorises it, and the [[ledger-service|Ledger service]] records the capture.

\`\`\`mermaid
sequenceDiagram
  Checkout->>Payments API: create intent
  Payments API->>PSP: authorise
  PSP-->>Payments API: authorised
  Payments API->>Ledger: post capture
\`\`\`
`,
  'services/payouts.md': `---
type: Service
title: Payouts
description: Sends settled balances to merchants.
tags: [payments]
---

# Payouts

Reads balances from the [[ledger-service|Ledger service]] and batches transfers twice a day.
`,
  'decisions/0004-double-entry.md': `---
type: Decision
title: "ADR 0004: Double-entry bookkeeping"
status: stable
---

# ADR 0004: Double-entry bookkeeping

Record money movements as balanced entries, never as balance updates.
`,
  'decisions/0007-idempotency-keys.md': `---
type: Decision
title: "ADR 0007: Idempotency keys on every write"
status: draft
generated: { by: claude-code/claude-opus-5-5, at: ${daysAgo(2)} }
---

# ADR 0007: Idempotency keys on every write

## Context

A retried capture was booked twice in [[2291-duplicate-captures|incident 2291]]. Clients retry on timeouts, and today the ledger can't tell a retry from a new request.

## Decision

Require an \`Idempotency-Key\` header on every ledger write. {==Keys are kept for 24 hours==}{>>PSP retries can arrive up to 72 h later, so 24 h is too short. — mkovacs<<} and a repeated key returns the stored response.

## Consequences

{==Clients that don't send a key get a 400.==}{>>Roll this out behind a warning first: log missing keys for two weeks before rejecting. — jtan<<} Checkout and payouts need a release before this ships.
`,
  'incidents/2291-duplicate-captures.md': `---
type: Incident
title: "Incident 2291: duplicate captures"
tags: [payments, ledger]
status: resolved
generated: { by: claude-code/claude-opus-5-5, at: ${daysAgo(15)} }
---

# Incident 2291: duplicate captures

A PSP timeout made checkout retry a capture, and the ledger booked it twice. See [[ledger-service|Ledger service]].
`,
  'runbooks/ledger-reconciliation.md': `---
type: Runbook
title: Ledger reconciliation
status: stable
stale_after: ${daysAgo(30)}
---

# Ledger reconciliation

Compare the day's postings with the bank statement for the [[ledger-service|Ledger service]].
`,
  'runbooks/legacy-refunds.md': `---
type: Runbook
title: Legacy refunds
status: deprecated
---

# Legacy refunds

Superseded by the refunds API.
`,
};

const SERVICE = 'services/ledger-service.md';

/** Replace the fake fixture Bundle with BUNDLE and open the service Concept. */
async function openDemo(page: Page) {
  // Open the folders the shots show; the fake Bundle's own state is discarded.
  await page.addInitScript(() => {
    localStorage.setItem(
      'sunstone:bundleState:/fake/bundle',
      JSON.stringify({ expandedFolders: ['services', 'decisions', 'runbooks', 'incidents'] }),
    );
  });
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate((bundle) => {
    const fake = (window as unknown as FakeWindow).__sunstoneFake;
    // Keep the root index.md and rewrite it in place: a 'modified' root index is
    // what switches the Bundle into OKF mode (lint, completion).
    for (const path of Object.keys(fake.files)) if (path !== 'index.md') fake.simulateExternalChange('removed', path);
    for (const [path, content] of Object.entries(bundle))
      fake.simulateExternalChange(path === 'index.md' ? 'modified' : 'created', path, content);
  }, BUNDLE);
  await tree.locator(`[data-path="${SERVICE}"]`).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('source of truth for balances');
  return { tree, editor };
}

async function showRightSidebar(page: Page) {
  const toggle = page.getByTestId('rail-toggle-right');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect.poll(async () => (await page.getByTestId('right-side-bar').boundingBox())?.width).toBeGreaterThan(0);
}

test.beforeAll(() => {
  mkdirSync(ASSET_DIR, { recursive: true });
});

async function hideLeftSidebar(page: Page) {
  const toggle = page.getByTestId('rail-toggle-left');
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1440, height: 900 } });

    test('hero', async ({ page }) => {
      await openDemo(page);
      await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', scheme);
      await showRightSidebar(page);
      await expect(page.getByTestId('meta-pill')).toBeVisible();
      await expect(page.getByTestId('right-side-bar')).toContainText('services/payment-flow');
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${ASSET_DIR}/hero-${scheme}.png` });
    });
  });

  test(`${scheme} wiki`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 760 } });
    const page = await context.newPage();
    await page.goto('https://wiki.sunstone.md/6-okf/okf-support');
    await expect(page.getByRole('heading', { name: 'OKF support' })).toBeVisible();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${ASSET_DIR}/wiki-${scheme}.png` });
    await context.close();
  });

  test.describe(`${scheme} features`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1100, height: 640 } });

    test('okf', async ({ page }) => {
      await openDemo(page);
      const pill = page.getByTestId('tile-header').getByTestId('meta-pill');
      await pill.hover();
      await expect(page.getByTestId('meta-popover')).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${ASSET_DIR}/okf-${scheme}.png`, clip: { x: 0, y: 0, width: 1100, height: 400 } });
    });

    test('footnotes', async ({ page }) => {
      const { editor } = await openDemo(page);
      await hideLeftSidebar(page);
      await page.setViewportSize({ width: 1100, height: 1000 });
      const ref = editor.locator('.cm-footnote-ref[data-footnote="pg-docs"]').first();
      await expect(async () => {
        await page.mouse.move(0, 0);
        await ref.hover();
        await expect(page.getByTestId('source-card')).toHaveCount(1, { timeout: 1500 });
      }).toPass();
      await page.waitForTimeout(300);
      // From the cited paragraph down to the first Sources entries.
      const top = Math.max(0, (await ref.boundingBox())!.y - 70);
      const sources = (await editor.getByTestId('sources-section').boundingBox())!;
      const bottom = Math.min(1000, sources.y + 150);
      await page.screenshot({ path: `${ASSET_DIR}/footnotes-${scheme}.png`, clip: { x: 0, y: top, width: 1100, height: bottom - top } });
    });

    test('fields', async ({ page }) => {
      await openDemo(page);
      await hideLeftSidebar(page);
      await page.getByTestId('frontmatter-toggle').click();
      // Read mode shows the frontmatter as a grid of fields.
      const grid = page.getByTestId('properties');
      await expect(grid).toBeVisible();
      await page.waitForTimeout(300);
      const box = (await grid.boundingBox())!;
      await page.screenshot({ path: `${ASSET_DIR}/fields-${scheme}.png`, clip: { x: 0, y: 0, width: 1100, height: Math.min(640, box.y + box.height + 24) } });
    });

    test('annotations', async ({ page }) => {
      const { tree, editor } = await openDemo(page);
      await tree.locator('[data-path="decisions/0007-idempotency-keys.md"]').click();
      await hideLeftSidebar(page);
      await expect(editor).toContainText('Idempotency-Key');
      const highlight = editor.locator('.cm-critic-highlight', { hasText: 'Keys are kept for 24 hours' });
      // The hover tooltip can miss the first pointer move while the editor settles.
      await expect(async () => {
        await page.mouse.move(0, 0);
        await highlight.hover();
        await expect(page.locator('.cm-critic-tooltip')).toBeVisible({ timeout: 1500 });
      }).toPass();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${ASSET_DIR}/annotations-${scheme}.png`, clip: { x: 0, y: 0, width: 1100, height: 470 } });
    });

    test('properties', async ({ page }) => {
      const { tree } = await openDemo(page);
      await tree.locator('[data-path="incidents/2291-duplicate-captures.md"]').click();
      await hideLeftSidebar(page);
      await page.getByTestId('frontmatter-toggle').click();
      // The YAML editor, and its lint, exist in editing mode only.
      await page.getByTestId('edit-toggle').click();
      const region = page.getByTestId('frontmatter');
      await expect(region.locator('.cm-content')).toContainText('status: resolved');
      // OKF-aware checks: `status` is one of draft / stable / deprecated.
      const error = region.locator('.cm-lintRange-error');
      await expect(error).toHaveCount(1);
      await error.hover();
      await expect(page.locator('.cm-tooltip-lint')).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${ASSET_DIR}/properties-${scheme}.png`, clip: { x: 0, y: 0, width: 1100, height: 360 } });
    });
  });
}
