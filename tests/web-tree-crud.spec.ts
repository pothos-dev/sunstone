import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import type { Page } from './fixtures';
import { WEB_BUNDLE_DIR } from './web-bundle';
import { mountShell, openFromTree, typeAtEnd, headCommit, commitCount } from './web-shell';

/**
 * Tree CRUD + the structural-op gate over the full-App WEB shell (branch
 * `feat/enable-web-writing`; ticket 08 §5). An authed user's create / rename /
 * delete from the interactive `App` tree each drive the real `/api` write chain
 * and land a git commit in the served fixture repo. Renaming a linked-to Concept
 * also rewrites its inbound links (folded into the one rename commit).
 *
 * The STRUCTURAL GATE: rename/move/delete rewrite links across the Bundle and
 * cannot run with an unsaved active buffer, so with a dirty buffer they route
 * through the blocking three-way `web-structural-modal` first. We drive the gate
 * with a drag-and-drop MOVE (no confirm dialog competes for the foreground), and
 * cover both "Save & continue" (commits the pending edit AND the move) and
 * "Cancel" (aborts atomically — no op, no commit).
 */

/** Open the context menu for a tree node by right-clicking its row. */
async function openRowMenu(page: Page, path: string): Promise<void> {
  await page.getByTestId('tree').locator(`[data-row-path="${path}"]`).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
}

test('create a Concept via the tree: it appears and lands a `create … via web` commit', async ({
  page,
}) => {
  const rel = 'crud-created.md';
  const abs = join(WEB_BUNDLE_DIR, rel);
  const name = rel.replace(/\.md$/, '');
  try {
    await mountShell(page, '/');
    const tree = page.getByTestId('tree');
    const before = headCommit().hash;

    // Root "+ New…" opens the context menu targeting the Bundle root.
    await page.getByTestId('root-new-concept').click();
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await page.getByTestId('context-menu').locator('[data-action="newConcept"]').click();
    await page.getByTestId('dialog-input').fill(name);
    await page.getByTestId('dialog-confirm').click();

    // It appears in the tree and opens (selected) in the editor.
    await expect(tree.locator(`[data-path="${rel}"]`)).toBeVisible();
    await expect(tree.locator(`[data-path="${rel}"]`)).toHaveClass(/selected/);

    // A real commit landed. `createConcept` writes an empty file then folds the
    // frontmatter scaffold into the SAME commit (amend-else-fresh), so HEAD is a
    // single `create <path> via web`.
    await expect.poll(() => headCommit().hash, { timeout: 10_000 }).not.toBe(before);
    expect(headCommit().subject).toBe(`create ${rel} via web`);
  } finally {
    rmSync(abs, { force: true });
  }
});

test('rename a linked-to Concept: rewrites the inbound link + lands a `rename … via web` commit', async ({
  page,
}) => {
  const targetRel = 'crud-target.md';
  const renamedRel = 'crud-renamed.md';
  const linkerRel = 'crud-linker.md';
  const targetAbs = join(WEB_BUNDLE_DIR, targetRel);
  const renamedAbs = join(WEB_BUNDLE_DIR, renamedRel);
  const linkerAbs = join(WEB_BUNDLE_DIR, linkerRel);

  // A second-client file on disk linking to the target, so the rename has an
  // inbound link to rewrite (link-rewrite where applicable).
  writeFileSync(
    linkerAbs,
    `---\ntype: concept\ntitle: Linker\n---\n\n# Linker\n\nSee [[crud-target]].\n`,
  );
  writeFileSync(
    targetAbs,
    `---\ntype: concept\ntitle: Crud Target\n---\n\n# Crud Target\n\nBody.\n`,
  );

  try {
    await mountShell(page, '/');
    const tree = page.getByTestId('tree');
    await expect(tree.locator(`[data-path="${targetRel}"]`)).toBeVisible({ timeout: 15_000 });

    const before = headCommit().hash;

    // Rename via the context menu (buffer clean → the structural gate is a
    // pass-through, no modal).
    await openRowMenu(page, targetRel);
    await page.getByTestId('context-menu').locator('[data-action="rename"]').click();
    await page.getByTestId('dialog-input').fill('crud-renamed');
    await page.getByTestId('dialog-confirm').click();

    // The tree reflects the rename.
    await expect(tree.locator(`[data-path="${targetRel}"]`)).toHaveCount(0);
    await expect(tree.locator(`[data-path="${renamedRel}"]`)).toBeVisible();

    // A rename commit landed …
    await expect.poll(() => headCommit().hash, { timeout: 10_000 }).not.toBe(before);
    expect(headCommit().subject).toBe(`rename ${targetRel} → ${renamedRel} via web`);
    // … and the inbound wikilink was rewritten (folded into that commit).
    await expect
      .poll(() => readFileSync(linkerAbs, 'utf8'), { timeout: 10_000 })
      .toContain('[[crud-renamed]]');
  } finally {
    rmSync(targetAbs, { force: true });
    rmSync(renamedAbs, { force: true });
    rmSync(linkerAbs, { force: true });
  }
});

test('delete a Concept via the tree: it is removed and lands a `delete … via web` commit', async ({
  page,
}) => {
  const rel = 'crud-doomed.md';
  const name = rel.replace(/\.md$/, '');
  const abs = join(WEB_BUNDLE_DIR, rel);
  try {
    await mountShell(page, '/');
    const tree = page.getByTestId('tree');

    // Create it through the UI first so it is TRACKED in git (a raw fs write
    // would be untracked, so deleting it stages no change → no commit).
    await page.getByTestId('root-new-concept').click();
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await page.getByTestId('context-menu').locator('[data-action="newConcept"]').click();
    await page.getByTestId('dialog-input').fill(name);
    await page.getByTestId('dialog-confirm').click();
    await expect(tree.locator(`[data-path="${rel}"]`)).toBeVisible();
    await expect.poll(() => headCommit().subject, { timeout: 10_000 }).toBe(`create ${rel} via web`);

    const before = headCommit().hash;

    await openRowMenu(page, rel);
    await page.getByTestId('context-menu').locator('[data-action="delete"]').click();
    // The confirm dialog must appear before anything is deleted.
    await expect(page.getByTestId('tree-dialog')).toContainText('Delete');
    await page.getByTestId('dialog-confirm').click();

    await expect(tree.locator(`[data-path="${rel}"]`)).toHaveCount(0);
    await expect.poll(() => headCommit().hash, { timeout: 10_000 }).not.toBe(before);
    expect(headCommit().subject).toBe(`delete ${rel} via web`);
  } finally {
    rmSync(abs, { force: true });
  }
});

test('structural gate: dirty buffer + rename → modal; "Save & continue" commits BOTH', async ({
  page,
}) => {
  const rel = 'gate-save.md';
  const renamedRel = 'gate-saved.md';
  const abs = join(WEB_BUNDLE_DIR, rel);
  const renamedAbs = join(WEB_BUNDLE_DIR, renamedRel);
  writeFileSync(abs, `---\ntype: concept\ntitle: Gate Save\n---\n\n# Gate Save\n\nBody.\n`);

  try {
    await mountShell(page, '/');
    const tree = page.getByTestId('tree');
    const content = await openFromTree(page, rel);

    // Dirty the active buffer.
    await typeAtEnd(page, content, '\n\nDIRTY_EDIT_BEFORE_RENAME');
    await expect(page.getByTestId('web-save')).toBeVisible();

    const before = commitCount();

    // Rename the dirty Concept → a link-rewriting structural op, which gates on
    // the dirty buffer → the blocking three-way structural modal.
    await openRowMenu(page, rel);
    await page.getByTestId('context-menu').locator('[data-action="rename"]').click();
    await page.getByTestId('dialog-input').fill('gate-saved');
    await page.getByTestId('dialog-confirm').click();
    const modal = page.getByTestId('web-structural-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // "Save & continue" flushes the pending edit (one commit) THEN runs the
    // rename (a second commit): two commits land and HEAD is the rename.
    await page.getByTestId('web-structural-save').click();
    await expect(modal).toHaveCount(0);
    await expect(tree.locator(`[data-path="${renamedRel}"]`)).toBeVisible();

    await expect.poll(() => commitCount(), { timeout: 10_000 }).toBe(before + 2);
    expect(headCommit().subject).toBe(`rename ${rel} → ${renamedRel} via web`);
    await expect(page.getByTestId('web-save')).toHaveCount(0);
  } finally {
    rmSync(abs, { force: true });
    rmSync(renamedAbs, { force: true });
  }
});

test('structural gate: "Cancel" aborts the rename — no op, no commit', async ({ page }) => {
  const rel = 'gate-cancel.md';
  const abs = join(WEB_BUNDLE_DIR, rel);
  const renamedAbs = join(WEB_BUNDLE_DIR, 'gate-cancelled.md');
  writeFileSync(abs, `---\ntype: concept\ntitle: Gate Cancel\n---\n\n# Gate Cancel\n\nBody.\n`);

  try {
    await mountShell(page, '/');
    const tree = page.getByTestId('tree');
    const content = await openFromTree(page, rel);

    await typeAtEnd(page, content, '\n\nDIRTY_EDIT_KEPT');
    await expect(page.getByTestId('web-save')).toBeVisible();

    const before = commitCount();

    await openRowMenu(page, rel);
    await page.getByTestId('context-menu').locator('[data-action="rename"]').click();
    await page.getByTestId('dialog-input').fill('gate-cancelled');
    await page.getByTestId('dialog-confirm').click();
    const modal = page.getByTestId('web-structural-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // "Cancel" aborts the rename atomically: the Concept keeps its name, the
    // buffer stays dirty, and NO commit lands.
    await page.getByTestId('web-structural-cancel').click();
    await expect(modal).toHaveCount(0);
    await expect(tree.locator(`[data-path="${rel}"]`)).toBeVisible();
    await expect(page.getByTestId('web-save')).toBeVisible();

    await page.waitForTimeout(1000);
    expect(commitCount()).toBe(before);
  } finally {
    rmSync(abs, { force: true });
    rmSync(renamedAbs, { force: true });
  }
});
