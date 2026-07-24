import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import { WEB_BUNDLE_DIR } from './web-bundle';

/**
 * A scratch Concept written into the SERVED Bundle to trigger live reload. The
 * web runner serves the throwaway temp copy (a real git repo built by
 * global-setup), not the in-repo fixture, so this write must target that copy
 * for the filesystem watcher to see it.
 */
const LIVE_NOTE = join(WEB_BUNDLE_DIR, 'live-note.md');

/**
 * The read-only "Sunstone Web" viewer with SERVER-SIDE RENDER
 * (slices: web-readonly-api-walking-skeleton + web-server-side-render).
 *
 * Drives the SSR'd web shell (adapter-node) against the read-only HTTP backend
 * (`sunstone-server` over the `tests/fixtures/web-bundle` fixture, proxied
 * through `/api`). Asserts:
 *   - the Explorer tree is server-rendered and present,
 *   - opening a Concept shows RENDERED HTML (headings/paragraphs) + a read-only
 *     Properties view (frontmatter), NOT raw markdown / CodeMirror,
 *   - a broken in-Bundle link is present but styled distinct (`.broken`),
 *   - clicking a resolved in-Bundle link navigates WITHIN the viewer (URL
 *     changes, the target renders) — no browser navigation away,
 *   - NO create/rename/delete/edit affordances exist anywhere.
 * Saves a screenshot to tests/screenshots/web-viewer.png.
 */
test('web viewer renders a Concept read-only with resolved + broken links', async ({ page }) => {
  await page.goto('/');

  // The web viewer shell (not the desktop <App/>) with a server-rendered tree.
  await expect(page.getByTestId('web-viewer')).toBeVisible();
  await expect(page.getByTestId('web-tree')).toBeVisible();
  expect(await page.getByTestId('tree-concept').count()).toBeGreaterThan(0);

  // Open the root index Concept via its header affordance (index.md is a
  // reserved file, not an ordinary tree row — mirrors desktop).
  await page.locator('[data-reserved-path="index.md"]').click();
  await expect(page).toHaveURL(/\/$/);

  // RENDERED output (not raw markdown): real heading + paragraph elements.
  const rendered = page.getByTestId('rendered');
  await expect(rendered.locator('h1')).toContainText('Web Bundle Home');

  // The document title is the open Concept's name (not a static fallback).
  await expect(page).toHaveTitle('Web Bundle Home');
  await expect(rendered.locator('p').first()).toBeVisible();

  // Read-only Properties view from frontmatter.
  await expect(page.getByTestId('properties')).toContainText('Web Bundle Home');

  // A broken in-Bundle link is present but visually distinct.
  await expect(rendered.locator('a.internal-link.broken')).toHaveCount(2); // missing.md + [[nope-wiki]]

  // A resolved in-Bundle link exists and navigates WITHIN the viewer.
  const good = rendered.locator('a.internal-link:not(.broken)').first();
  await expect(good).toHaveAttribute('data-path', 'good.md');

  await page.screenshot({ path: 'tests/screenshots/web-viewer.png', fullPage: true });

  await good.click();
  await expect(page).toHaveURL(/\/good$/);
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Good Concept');
  await expect(page).toHaveTitle('Good Concept');

  // No write affordances anywhere in the read-only web build.
  await expect(page.getByTestId('root-new-concept')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ New…' })).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
});

/**
 * Live reload over SSE (slice: web-live-reload-sse). An EXTERNAL edit to the
 * Bundle on disk (the web app never writes) is delivered to the viewer via
 * `/api/events` and reacts: a create/delete refreshes the tree, and a modify to
 * the open Concept re-renders it — all without a manual refresh. Drives real
 * filesystem changes against the fixture Bundle the Rust server watches.
 * Saves a screenshot to tests/screenshots/web-live-reload.png.
 */
test('live reload: external filesystem changes update the viewer via SSE', async ({ page }) => {
  await rm(LIVE_NOTE, { force: true }); // clean slate

  const liveRow = page.getByTestId('tree-concept').filter({ hasText: 'live-note' });
  const heading = page.getByTestId('rendered').locator('h1');

  await page.goto('/');
  await expect(heading).toContainText('Web Bundle Home');
  await expect(liveRow).toHaveCount(0);

  // Let the viewer's EventSource finish subscribing on the server before the
  // first change — a broadcast only reaches already-connected subscribers, so a
  // change fired mid-connect would be missed (there is no DOM signal for "SSE
  // open", hence a short settle).
  await page.waitForTimeout(1500);

  try {
    // CREATE on disk → SSE → tree refresh (the new Concept appears).
    await writeFile(LIVE_NOTE, '# Live One\n\nfirst body\n');
    await expect(liveRow).toHaveCount(1, { timeout: 15_000 });

    // Open it; it renders.
    await liveRow.click();
    await expect(page).toHaveURL(/\/live-note$/);
    await expect(heading).toContainText('Live One');

    // MODIFY the OPEN Concept on disk → SSE → re-render without manual refresh.
    await writeFile(LIVE_NOTE, '# Live Two\n\nsecond body\n');
    await expect(heading).toContainText('Live Two', { timeout: 15_000 });

    await page.screenshot({ path: 'tests/screenshots/web-live-reload.png', fullPage: true });

    // DELETE on disk → SSE → tree refresh (the row disappears).
    await rm(LIVE_NOTE, { force: true });
    await expect(liveRow).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await rm(LIVE_NOTE, { force: true });
  }
});

/**
 * Bundle-wide full-text Search (slice: web-full-text-search). Ctrl+Shift+F opens
 * the modal; a query lists path/line/snippet hits with the match highlighted;
 * selecting a hit opens that Concept in the viewer. Saves a screenshot to
 * tests/screenshots/web-search.png.
 */
test('full-text search: Ctrl+Shift+F lists hits and opens a Concept', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('web-viewer')).toBeVisible();
  // Gate on hydration: the Tags Section renders from its onMount fetch, which
  // runs in the same hydration cycle as the viewer's Ctrl+Shift+F key listener,
  // so its presence means the listener is registered.
  await expect(page.getByTestId('tag-browser')).toBeVisible();

  // Open the Search modal.
  await page.keyboard.press('Control+Shift+F');
  await expect(page.getByTestId('search-panel')).toBeVisible();

  // A query lists hits with a highlighted snippet ("paragraph" is in the body).
  await page.getByTestId('search-input').fill('paragraph');
  const firstHit = page.getByTestId('search-item').first();
  await expect(firstHit).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('search-snippet').first().locator('mark')).toContainText(
    /paragraph/i,
  );

  await page.screenshot({ path: 'tests/screenshots/web-search.png', fullPage: true });

  // Selecting a hit opens that Concept in the viewer (and closes the modal).
  const hitPath = await firstHit.getAttribute('data-path');
  await firstHit.click();
  // The viewer routes to the Concept's pretty URL (`.md`/`/index` dropped).
  const pretty = (p: string): string => {
    let s = p.replace(/\.md$/i, '');
    if (s === 'index') return '/';
    s = s.replace(/\/index$/, '');
    return '/' + s.split('/').map(encodeURIComponent).join('/');
  };
  await expect.poll(() => new URL(page.url()).pathname).toBe(pretty(hitPath ?? ''));
  await expect(page.getByTestId('search-panel')).toHaveCount(0);
  await expect(page.getByTestId('rendered')).toBeVisible();
});

/**
 * Index-backed sidebar Sections (slice: web-index-backed-sidebars): Backlinks,
 * Tags, and Outline over the core index. Saves tests/screenshots/web-sidebars.png.
 */
test('index-backed sidebars: backlinks, tags, and outline', async ({ page }) => {
  // Open a Concept that is linked-to (index.md links to good.md) and has headings.
  await page.goto('/good');
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Good Concept');

  // Outline lists the open Concept's headings; the rendered headings carry the
  // matching id slugs so selecting one scrolls the view.
  const outline = page.getByTestId('outline');
  await expect(outline.getByTestId('outline-entry')).toHaveCount(2);
  await expect(page.locator('[data-testid="rendered"] h1#good-concept')).toBeVisible();
  await expect(page.locator('[data-testid="rendered"] h2#details')).toBeVisible();
  await outline.getByTestId('outline-entry').filter({ hasText: 'Details' }).click();
  await expect(page.locator('[data-testid="rendered"] h2#details')).toBeInViewport();

  // Tags lists bundle tags with counts; expanding one reveals its Concepts.
  const tags = page.getByTestId('tag-browser');
  await expect(tags).toBeVisible();
  const demo = tags.getByTestId('tag').filter({ hasText: 'demo' });
  await expect(demo).toBeVisible();
  await expect(demo.getByTestId('tag-count')).toHaveText('1');
  await demo.click();
  await expect(tags.getByTestId('tag-concept').filter({ hasText: 'index' })).toBeVisible();

  // Backlinks lists inbound linkers (index.md links to good.md).
  const backlinks = page.getByTestId('backlinks');
  await expect(backlinks.getByTestId('backlink')).toHaveCount(1);
  const backlink = backlinks.getByTestId('backlink').first();
  await expect(backlink).toHaveAttribute('data-path', 'index.md');

  await page.screenshot({ path: 'tests/screenshots/web-sidebars.png', fullPage: true });

  // Selecting a backlink navigates within the viewer.
  await backlink.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Web Bundle Home');
});

/**
 * The Tags Section is hidden entirely when the Bundle carries no tags (as on
 * desktop). Driven by mocking `/api/tags` empty at the browser network layer.
 */
test('tags section is hidden when the bundle has no tags', async ({ page }) => {
  await page.route('**/api/tags', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.goto('/');
  await expect(page.getByTestId('web-viewer')).toBeVisible();
  await expect(page.getByTestId('tag-browser')).toHaveCount(0);
});

/**
 * Mermaid Diagrams (slice: web-mermaid-diagrams). The server leaves ```mermaid
 * fences inert (`<code class="language-mermaid">`); a client-side island
 * hydrates them into rendered Diagrams. A valid diagram becomes an <svg>; a
 * malformed one degrades to an in-place error panel without breaking the page.
 * Saves tests/screenshots/web-mermaid.png.
 */
test('mermaid diagrams hydrate, and a malformed one degrades gracefully', async ({ page }) => {
  await page.goto('/diagram');
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Diagram Concept');

  // The valid diagram hydrates into an SVG inside a mermaid container.
  await expect(
    page.locator('[data-testid="rendered"] .web-mermaid-render svg').first(),
  ).toBeVisible({ timeout: 15_000 });

  // The malformed diagram degrades to an in-place error panel …
  await expect(page.getByTestId('mermaid-error')).toBeVisible({ timeout: 15_000 });
  // … and the page is still intact (heading + body + tree present).
  await expect(page.getByTestId('rendered').locator('h1')).toBeVisible();
  await expect(page.getByTestId('rendered')).toContainText('stays intact');
  await expect(page.getByTestId('web-tree')).toBeVisible();

  await page.screenshot({ path: 'tests/screenshots/web-mermaid.png', fullPage: true });
});

/**
 * Desktop parity pass (follow-up): dark-by-default theme (follows the OS, no
 * manual toggle — matching the desktop shell), an icon-less collapsible Explorer
 * with implicit index, and collapsible Accordion Sidebars. Saves a DARK-mode
 * screenshot to tests/screenshots/web-parity-shell-dark.png.
 */
test('desktop parity: dark theme, collapsible tree/index, accordion sidebars', async ({
  page,
}) => {
  // Dark by default: with a dark OS scheme and no stored choice, the app root
  // gets data-theme="dark" (CSS tokens follow the OS, not a light fallback). The
  // theme follows the OS with NO manual toggle — matching the desktop shell.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const root = page.getByTestId('web-viewer');
  await expect(root).toHaveAttribute('data-theme', 'dark');

  // index.md is NOT an ordinary tree row (reserved, hidden) — at the root and
  // inside the guide folder.
  await expect(page.locator('[data-testid="tree-concept"][data-path="index.md"]')).toHaveCount(0);
  await expect(
    page.locator('[data-testid="tree-concept"][data-path="guide/index.md"]'),
  ).toHaveCount(0);

  // All folders open COLLAPSED by default — the guide folder's ordinary child
  // (topic.md) is hidden until the folder is expanded (mirrors desktop).
  const guideDir = page.getByTestId('tree-dir').filter({ hasText: 'guide' });
  const topic = page.locator('[data-testid="tree-concept"][data-path="guide/topic.md"]');
  await expect(topic).toHaveCount(0);

  // Clicking the twisty expands the folder (child appears) then collapses it.
  const twisty = guideDir.getByRole('button', { name: 'guide' });
  await twisty.click();
  await expect(topic).toBeVisible();
  await twisty.click();
  await expect(topic).toHaveCount(0);

  // Clicking the folder NAME opens its implicit index.md (mirrors desktop).
  await guideDir.locator('.name-toggle').click();
  await expect(page).toHaveURL(/\/guide$/);
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Guide');

  await page.screenshot({ path: 'tests/screenshots/web-parity-shell-dark.png', fullPage: true });

  // The sidebar Sections collapse (accordion): collapsing Explorer removes the
  // tree body.
  await expect(page.getByTestId('web-tree')).toBeVisible();
  await page.getByTestId('explorer-section-header').click();
  await expect(page.getByTestId('web-tree')).toHaveCount(0);
});

/**
 * Quick-nav command palette (slice: web-quick-nav-palette, rebuilt on the
 * reconciled anon surface). Ctrl/Cmd+K (and the rail's quick-nav icon) opens a
 * fuzzy palette over Concept paths + tags; typing filters, and selecting a
 * result navigates via SvelteKit client-side routing (no full page reload).
 * Saves tests/screenshots/web-quicknav.png.
 */
test('quick-nav: Ctrl+K opens a fuzzy palette that navigates client-side', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('web-viewer')).toBeVisible();
  // Gate on hydration: the Tags Section renders from its onMount fetch, which
  // runs in the same hydration cycle as the viewer's key listeners.
  await expect(page.getByTestId('tag-browser')).toBeVisible();

  // Ctrl+K opens the palette; with an empty query it browses all Concepts.
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('quick-nav')).toBeVisible();
  await expect(page.getByTestId('quick-nav-item').first()).toBeVisible();

  // A marker on `window` that a full page reload would wipe — proves the
  // subsequent navigation is client-side (SvelteKit routing), not a reload.
  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__noReload = true));

  // Typing filters to the matching Concept (fuzzy over paths).
  await page.getByTestId('quick-nav-input').fill('good');
  const goodItem = page.locator('[data-testid="quick-nav-item"][data-path="good.md"]');
  await expect(goodItem).toBeVisible();

  await page.screenshot({ path: 'tests/screenshots/web-quicknav.png', fullPage: true });

  // Selecting it navigates (URL + render) and closes the palette — no reload.
  await goodItem.click();
  await expect(page).toHaveURL(/\/good$/);
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Good Concept');
  await expect(page.getByTestId('quick-nav')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__noReload)).toBe(
    true,
  );

  // The rail's quick-nav icon opens the same palette; a tag match is offered.
  await page.getByTestId('rail-quicknav').click();
  await expect(page.getByTestId('quick-nav')).toBeVisible();
  await page.getByTestId('quick-nav-input').fill('web');
  await expect(page.locator('[data-testid="quick-nav-tag"][data-tag="web"]')).toBeVisible();

  // Escape closes it.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-nav')).toHaveCount(0);
});

/**
 * Layout parity (rebuilt on main's auth-aware WebViewer): the anon read surface
 * adopts the desktop chrome — a far-left ActivityRail (menu stub + quick-nav +
 * search + a bottom user slot wired to the REAL Auth.js sign-in), SidebarEdge
 * click/drag borders, and a slim concept strip (history + Properties + export +
 * theme). Asserts the rail launches search, the user slot surfaces the real
 * sign-in affordance (NOT an inert WebUserMenu scaffold), the anon reader has no
 * Edit button, the theme toggle flips, and dragging the left edge resizes +
 * persists the Sidebar width. Saves tests/screenshots/web-layout-parity.png.
 */
test('layout parity: rail, real sign-in, concept strip, theme toggle, edge resize persists', async ({
  page,
}) => {
  await page.goto('/good');
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Good Concept');

  // The far-left activity rail carries menu + quick-nav + search + a user slot.
  await expect(page.getByTestId('activity-rail')).toBeVisible();
  await expect(page.getByTestId('rail-menu')).toBeVisible();
  await expect(page.getByTestId('rail-quicknav')).toBeVisible();
  await expect(page.getByTestId('rail-search')).toBeVisible();
  await expect(page.getByTestId('rail-user')).toBeVisible();

  // The user slot surfaces the REAL Auth.js sign-in (a link into /auth/signin),
  // signed out — NOT an inert placeholder / WebUserMenu scaffold.
  const signIn = page.getByTestId('web-sign-in');
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute('href', '/auth/signin');
  await expect(page.getByTestId('user-menu')).toHaveCount(0);
  await expect(page.getByTestId('web-sign-out')).toHaveCount(0);

  // The rail's search icon opens the existing WebSearch modal; Escape closes it.
  await page.getByTestId('rail-search').click();
  await expect(page.getByTestId('search-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search-panel')).toHaveCount(0);

  // The slim concept strip carries history + Properties + export + theme; the
  // old header collapse toggles are gone (collapse moved to the edges), and the
  // anon reader has no Edit affordance.
  await expect(page.getByTestId('concept-strip')).toBeVisible();
  await expect(page.getByTestId('nav-back')).toBeVisible();
  await expect(page.getByTestId('nav-forward')).toBeVisible();
  await expect(page.getByTestId('properties-panel-toggle')).toBeVisible();
  await expect(page.getByTestId('export-pdf')).toBeVisible();
  await expect(page.getByTestId('theme-toggle')).toBeVisible();
  await expect(page.getByTestId('sidebar-toggle')).toHaveCount(0);
  await expect(page.getByTestId('right-sidebar-toggle')).toHaveCount(0);
  await expect(page.getByTestId('web-edit-toggle')).toHaveCount(0);

  // The theme toggle flips light / dark on the app root.
  const root = page.getByTestId('web-viewer');
  const before = await root.getAttribute('data-theme');
  await page.getByTestId('theme-toggle').click();
  const after = await root.getAttribute('data-theme');
  expect(after).not.toBe(before);

  await page.screenshot({ path: 'tests/screenshots/web-layout-parity.png', fullPage: true });

  // Dragging the left edge resizes the left Sidebar; the width persists on reload.
  const aside = page.getByTestId('left-side-bar');
  const startWidth = (await aside.boundingBox())?.width ?? 0;
  const edge = page.getByTestId('left-sidebar-edge');
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await aside.boundingBox())?.width).toBeGreaterThan(startWidth + 70);

  // The width round-trips through localStorage (sunstone:webUI).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('sunstone:webUI');
        if (!raw) return null;
        return (JSON.parse(raw) as { leftSidebarWidth?: number }).leftSidebarWidth ?? null;
      }),
    )
    .toBeGreaterThan(startWidth + 70);

  await page.reload();
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Good Concept');
  await expect
    .poll(async () => (await page.getByTestId('left-side-bar').boundingBox())?.width)
    .toBeGreaterThan(startWidth + 70);
});

/**
 * Round-2 polish (rebuilt on the reconciled surface): edge-click sidebar
 * collapse (left + right borders), collapsible Properties, back/forward strip
 * nav, and localStorage persistence of UI state across reloads. Saves the
 * DARK-mode parity shot to tests/screenshots/web-parity-dark.png.
 */
test('polish: edge collapse/strip-nav, Properties collapse, and persistence', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/good');
  await expect(page.getByTestId('web-viewer')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Good Concept');

  // Clicking the left edge collapses the left Sidebar; clicking again restores it.
  await expect(page.getByTestId('left-side-bar')).toBeVisible();
  await page.getByTestId('left-sidebar-edge').click();
  await expect(page.getByTestId('left-side-bar')).not.toBeVisible();
  await page.getByTestId('left-sidebar-edge').click();
  await expect(page.getByTestId('left-side-bar')).toBeVisible();

  // Clicking the right edge collapses the right Sidebar; clicking again restores it.
  await expect(page.getByTestId('right-side-bar')).toBeVisible();
  await page.getByTestId('right-sidebar-edge').click();
  await expect(page.getByTestId('right-side-bar')).not.toBeVisible();
  await page.getByTestId('right-sidebar-edge').click();
  await expect(page.getByTestId('right-side-bar')).toBeVisible();

  // Properties collapses (body removed) and re-expands.
  await expect(page.getByTestId('properties')).toBeVisible();
  await page.getByTestId('properties-panel-toggle').click();
  await expect(page.getByTestId('properties')).toHaveCount(0);

  // Screenshot the DARK parity view with Properties re-expanded.
  await page.getByTestId('properties-panel-toggle').click();
  await expect(page.getByTestId('properties')).toBeVisible();
  await page.screenshot({ path: 'tests/screenshots/web-parity-dark.png', fullPage: true });

  // Back / forward: navigate to a sibling Concept, then step back + forward.
  await page.locator('[data-testid="tree-concept"][data-path="diagram.md"]').click();
  await expect(page).toHaveURL(/\/diagram$/);
  await page.getByTestId('nav-back').click();
  await expect(page).toHaveURL(/\/good$/);
  await page.getByTestId('nav-forward').click();
  await expect(page).toHaveURL(/\/diagram$/);

  // --- Persistence across reload ---
  await page.goto('/good');
  // The guide folder holds an index.md, so it defaults COLLAPSED. EXPAND it (a
  // non-default folder state), and collapse the Tags Section and Properties, so
  // the reload below proves all three UI choices round-trip through localStorage.
  const guideDir = page.getByTestId('tree-dir').filter({ hasText: 'guide' });
  const topic = page.locator('[data-testid="tree-concept"][data-path="guide/topic.md"]');
  await expect(topic).toHaveCount(0);
  await guideDir.getByRole('button', { name: 'guide' }).click();
  await expect(topic).toBeVisible();
  await page.getByTestId('tags-section-header').click();
  await expect(page.getByTestId('tag-browser')).toHaveCount(0);
  await page.getByTestId('properties-panel-toggle').click();
  await expect(page.getByTestId('properties')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Good Concept');
  // The expanded folder and the two collapses were restored from localStorage.
  await expect(topic).toBeVisible();
  await expect(page.getByTestId('tag-browser')).toHaveCount(0);
  await expect(page.getByTestId('properties')).toHaveCount(0);

  // Sidebar-collapse also persists.
  await page.getByTestId('left-sidebar-edge').click();
  await expect(page.getByTestId('left-side-bar')).not.toBeVisible();
  await page.reload();
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Good Concept');
  await expect(page.getByTestId('left-side-bar')).not.toBeVisible();
});

/**
 * CriticMarkup annotations (slice: web-critic-markup-styling). The shared Rust
 * renderer emits track-change + annotation HTML in the Concept body — addition
 * (<ins.critic-add>), deletion (<del.critic-del>), substitution (adjacent
 * del+add), highlight (<mark.critic-highlight>) and an inline comment callout
 * (<span.critic-comment>). The web viewer styles them (mirroring the desktop CM
 * palette). Asserts each mark type is present + visible in the rendered body.
 * Saves a screenshot to tests/screenshots/web-critic.png.
 */
test('critic markup: additions, deletions, substitutions, highlights, and comments render', async ({
  page,
}) => {
  await page.goto('/critic');
  const rendered = page.getByTestId('rendered');
  await expect(rendered.locator('h1')).toContainText('Critic Concept');

  // Addition + deletion track-changes are present and visible.
  await expect(rendered.locator('ins.critic-add').first()).toBeVisible();
  await expect(rendered.locator('del.critic-del').first()).toBeVisible();
  await expect(rendered.locator('ins.critic-add').first()).toContainText('inserted text');
  await expect(rendered.locator('del.critic-del').first()).toContainText('removed text');

  // A substitution is an adjacent deletion + addition pair, so both mark types
  // appear more than once across the document.
  await expect(rendered.locator('del.critic-del')).toHaveCount(2); // deletion + substitution's old
  await expect(rendered.locator('ins.critic-add')).toHaveCount(2); // addition + substitution's new

  // Highlight + its bound inline comment callout (icon + note text).
  const highlight = rendered.locator('mark.critic-highlight');
  await expect(highlight).toBeVisible();
  await expect(highlight).toContainText('highlighted term');
  const comment = rendered.locator('span.critic-comment');
  await expect(comment).toBeVisible();
  await expect(comment.locator('.critic-comment-text')).toContainText('an editorial note');
  await expect(comment.locator('.critic-comment-icon svg')).toBeVisible();

  await page.screenshot({ path: 'tests/screenshots/web-critic.png', fullPage: true });
});
