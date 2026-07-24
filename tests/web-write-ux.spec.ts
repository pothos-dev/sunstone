import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import { WEB_BUNDLE_DIR, TEST_AUTH_NAME } from './web-bundle';
import { mountShell, openFromTree, cmContent, headCommit, commitCount, typeAtEnd } from './web-shell';

/**
 * Web WRITE UX nuances over the REAL full-App shell (branch
 * `feat/enable-web-writing`). Three explicit-Save behaviours that the base
 * `web-write` happy-path spec does not cover:
 *
 *  1. **Property → Save.** A Properties-panel frontmatter edit stays IN-MEMORY
 *     (marks `web-dirty`, lands NO commit) until an explicit Save folds body +
 *     frontmatter into ONE `edit <path> via web` commit. Proves the web-gated
 *     suppression of Tile's eager `flush()` on a property edit.
 *  2. **Nav gating.** A dirty buffer's own in-editor navigations — a wikilink
 *     click and Back — route through the three-way `web-leave-modal`: Cancel
 *     keeps you put (no nav, no commit); Save commits then navigates.
 *  3. **Slug-anchor on web.** Renaming a referenced heading + Save rewrites the
 *     inbound `[[…#anchor]]` in another Concept on disk, folded into the
 *     `edit … via web` commit per the server's amend-else-fresh rule.
 *
 * Each test writes its OWN scratch Concept(s) into the SERVED Bundle copy (the
 * temp git repo global-setup built), never the in-repo fixture, and cleans up.
 */

/** Read a served-Bundle file from disk (absolute path under WEB_BUNDLE_DIR). */
function diskContent(rel: string): string {
  return readFileSync(join(WEB_BUNDLE_DIR, rel), 'utf8');
}

test('a Properties edit stays in-memory (web-dirty, NO commit) until Save folds it into one commit', async ({
  page,
}) => {
  const rel = 'prop-target.md';
  const abs = join(WEB_BUNDLE_DIR, rel);
  const newTitle = `Prop Edited ${Date.now()}`;
  writeFileSync(abs, `---\ntype: concept\ntitle: Prop Target\n---\n\n# Prop Target\n\nBody line.\n`);

  try {
    await mountShell(page, '/');
    const content = await openFromTree(page, rel);
    await expect(content).toContainText('Body line');

    // Turn the global Properties panel on, then edit the `title` scalar value.
    // (The Properties toggle lives in the per-Tile header — `properties-toggle` —
    // after the layout rework moved it out of the old concept strip.)
    await page.getByTestId('properties-toggle').click();
    const props = page.getByTestId('properties');
    await expect(props).toBeVisible();
    const titleInput = props.getByTestId('scalar-title');
    await expect(titleInput).toBeVisible();

    const before = commitCount();
    await titleInput.fill(newTitle);
    // Scalars commit through the input's native `change` (blur/Enter), not on
    // every keystroke — blur it (staying in this tile, so no Concept switch).
    await titleInput.blur();

    // The property edit marks the buffer dirty WITHOUT eager-committing: the dot
    // shows, Save enables, and NO new commit landed (explicit-save only).
    await expect(page.getByTestId('web-dirty')).toBeVisible();
    await expect(page.getByTestId('web-save')).toBeEnabled();
    await page.waitForTimeout(800);
    expect(commitCount()).toBe(before);
    // The old title is still what is on disk — nothing was persisted yet.
    expect(diskContent(rel)).toContain('title: Prop Target');

    // Explicit Save folds the frontmatter change into ONE commit.
    await page.getByTestId('web-save').click();
    await expect(page.getByTestId('web-dirty')).toHaveCount(0);
    await expect.poll(() => commitCount(), { timeout: 10_000 }).toBe(before + 1);
    const head = headCommit();
    expect(head.subject).toBe(`edit ${rel} via web`);
    expect(head.name).toBe(TEST_AUTH_NAME);
    // The committed content carries the new frontmatter value.
    expect(diskContent(rel)).toContain(`title: ${newTitle}`);
  } finally {
    rmSync(abs, { force: true });
  }
});

test('a dirty wikilink navigation gates on the leave modal: Cancel stays, Save commits then navigates', async ({
  page,
}) => {
  const srcRel = 'navsrc.md';
  const dstRel = 'navdst.md';
  const srcAbs = join(WEB_BUNDLE_DIR, srcRel);
  const dstAbs = join(WEB_BUNDLE_DIR, dstRel);
  const marker = `NAVWIKI_${Date.now()}`;
  writeFileSync(
    srcAbs,
    `---\ntype: concept\ntitle: Nav Source\n---\n\n# Nav Source\n\nJump to [[navdst]] here.\n`,
  );
  writeFileSync(dstAbs, `---\ntype: concept\ntitle: Nav Dest\n---\n\n# Nav Dest\n\nDestination body.\n`);

  try {
    await mountShell(page, '/');
    const content = await openFromTree(page, srcRel);
    await expect(content).toContainText('Nav Source');

    // Dirty the buffer, then click the in-editor wikilink to navdst.
    await typeAtEnd(page, content, `\n\n${marker}`);
    await expect(page.getByTestId('web-dirty')).toBeVisible();

    const wikilink = page
      .getByTestId('editor')
      .locator('[data-wiki-link-target="navdst"]')
      .first();
    await expect(wikilink).toBeVisible();

    const before = commitCount();
    await wikilink.click();

    // The three-way leave modal blocks the navigation. Cancel keeps us on the
    // dirty source: no navigation, no commit.
    await expect(page.getByTestId('web-leave-modal')).toBeVisible();
    await page.getByTestId('web-leave-cancel').click();
    await expect(page.getByTestId('web-leave-modal')).toHaveCount(0);
    await expect(content).toContainText('Nav Source');
    await expect(page.getByTestId('web-dirty')).toBeVisible();
    expect(commitCount()).toBe(before);

    // Click the wikilink again, this time Save & navigate: one commit lands, then
    // the destination Concept opens.
    await wikilink.click();
    await expect(page.getByTestId('web-leave-modal')).toBeVisible();
    await page.getByTestId('web-leave-save').click();
    await expect(page.getByTestId('web-leave-modal')).toHaveCount(0);
    await expect.poll(() => commitCount(), { timeout: 10_000 }).toBe(before + 1);
    expect(headCommit().subject).toBe(`edit ${srcRel} via web`);
    expect(diskContent(srcRel)).toContain(marker);
    // Navigation actually followed through to the destination Concept.
    await expect(cmContent(page)).toContainText('Destination body', { timeout: 10_000 });
  } finally {
    rmSync(srcAbs, { force: true });
    rmSync(dstAbs, { force: true });
  }
});

test('a dirty Back navigation gates on the leave modal: Cancel stays on the dirty Concept', async ({
  page,
}) => {
  const aRel = 'navback-a.md';
  const bRel = 'navback-b.md';
  const aAbs = join(WEB_BUNDLE_DIR, aRel);
  const bAbs = join(WEB_BUNDLE_DIR, bRel);
  const marker = `NAVBACK_${Date.now()}`;
  writeFileSync(aAbs, `---\ntype: concept\ntitle: Back A\n---\n\n# Back A\n\nConcept A body.\n`);
  writeFileSync(bAbs, `---\ntype: concept\ntitle: Back B\n---\n\n# Back B\n\nConcept B body.\n`);

  try {
    await mountShell(page, '/');
    // Build a two-entry history: open A, then B (A is clean, so no gate on switch).
    await openFromTree(page, aRel);
    const content = await openFromTree(page, bRel);
    await expect(content).toContainText('Concept B body');

    // Dirty B, then press Back — the leave modal must block the history nav.
    await typeAtEnd(page, content, `\n\n${marker}`);
    await expect(page.getByTestId('web-dirty')).toBeVisible();

    const before = commitCount();
    const back = page.getByTestId('nav-back');
    await expect(back).toBeEnabled();
    await back.click();

    await expect(page.getByTestId('web-leave-modal')).toBeVisible();
    await page.getByTestId('web-leave-cancel').click();
    await expect(page.getByTestId('web-leave-modal')).toHaveCount(0);
    // Cancel keeps us on the dirty B (no nav to A), and lands no commit.
    await expect(content).toContainText('Concept B body');
    await expect(page.getByTestId('web-dirty')).toBeVisible();
    expect(commitCount()).toBe(before);
    expect(diskContent(bRel)).not.toContain(marker);

    // Save & Back: commit lands, then A opens.
    await back.click();
    await expect(page.getByTestId('web-leave-modal')).toBeVisible();
    await page.getByTestId('web-leave-save').click();
    await expect(page.getByTestId('web-leave-modal')).toHaveCount(0);
    await expect.poll(() => commitCount(), { timeout: 10_000 }).toBe(before + 1);
    expect(headCommit().subject).toBe(`edit ${bRel} via web`);
    await expect(cmContent(page)).toContainText('Concept A body', { timeout: 10_000 });
  } finally {
    rmSync(aAbs, { force: true });
    rmSync(bAbs, { force: true });
  }
});

test('renaming a referenced heading + Save rewrites the inbound anchor on disk, folded into the edit commit', async ({
  page,
}) => {
  const targetRel = 'sl-web-target.md';
  const sourceRel = 'sl-web-source.md';
  const targetAbs = join(WEB_BUNDLE_DIR, targetRel);
  const sourceAbs = join(WEB_BUNDLE_DIR, sourceRel);
  writeFileSync(
    targetAbs,
    `---\ntype: concept\ntitle: SL Web Target\n---\n\n# SL Web Target\n\n## Deep Section\n\nDeep body.\n`,
  );
  writeFileSync(
    sourceAbs,
    `---\ntype: concept\ntitle: SL Web Source\n---\n\n# SL Web Source\n\nJump to [[sl-web-target#deep-section]] now.\n`,
  );

  try {
    await mountShell(page, '/');
    const content = await openFromTree(page, targetRel);
    await expect(content).toContainText('Deep Section');

    // Rename `## Deep Section` -> `## Deep Sectioner` (slug deep-section ->
    // deep-sectioner) by appending to the heading line in the buffer.
    const headingLine = page
      .getByTestId('editor')
      .locator('.cm-line', { hasText: 'Deep Section' })
      .first();
    await headingLine.click();
    await page.keyboard.press('End');
    await page.keyboard.type('er');
    await expect(page.getByTestId('web-dirty')).toBeVisible();

    const before = commitCount();
    await page.getByTestId('web-save').click();
    await expect(page.getByTestId('web-dirty')).toHaveCount(0);

    // The inbound anchor in the OTHER Concept is rewritten on disk to the new slug.
    await expect
      .poll(() => diskContent(sourceRel), { timeout: 10_000 })
      .toContain('[[sl-web-target#deep-sectioner]]');
    // The target's own heading was persisted with the new text.
    expect(diskContent(targetRel)).toContain('## Deep Sectioner');

    // Amend-else-fresh: the rewrite of the inbound anchor is FOLDED into the
    // `edit <target> via web` commit (HEAD is our matching edit), so exactly ONE
    // new commit landed and its subject is still the edit.
    await expect.poll(() => commitCount(), { timeout: 10_000 }).toBe(before + 1);
    expect(headCommit().subject).toBe(`edit ${targetRel} via web`);
  } finally {
    rmSync(targetAbs, { force: true });
    rmSync(sourceAbs, { force: true });
  }
});
