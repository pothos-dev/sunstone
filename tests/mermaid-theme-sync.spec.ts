import { test, expect } from './fixtures';

/**
 * Slice: mermaid-theme-sync (ADR-0005, option 5a).
 *
 * A rendered Diagram is a baked SVG inside a CodeMirror StateField (outside
 * Svelte reactivity), so a light/dark flip can't recolour it via CSS — AND
 * CodeMirror does not reconcile block-widget DOM for an in-place decoration
 * change. So on a `theme.resolved` change App.svelte calls `setEditorMermaidTheme`,
 * which RECONFIGURES the mode Compartment: the mermaid field is rebuilt with the
 * new theme and every diagram's `toDOM` re-runs, re-rendering it in the app's
 * palette (mermaid `base` theme + `themeVariables` from the app's CSS tokens).
 *
 * The app theme is OS-driven (`prefers-color-scheme`), so we flip the emulated
 * media and assert the diagram re-rendered: each `mermaid.render()` uses a fresh
 * monotonic id, so a re-render swaps in an SVG with a NEW id (the previous baked
 * SVG would keep its id if nothing re-rendered).
 */
test('mermaid: flipping the theme re-renders an already-rendered diagram', async ({
  page,
}) => {
  // Start in light mode.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();

  await editor.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  const diagram = editor.locator('.cm-mermaid svg');
  await expect(diagram).toBeVisible({ timeout: 15000 });

  // The app root reflects the light theme (sanity check the theme plumbing).
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'light');

  // Record the rendered SVG's id (each render uses a fresh `cm-mermaid-*` id).
  const lightId = await diagram.getAttribute('id');
  expect(lightId).toBeTruthy();

  // Flip the OS scheme to dark; the theme store tracks matchMedia live, so the
  // app root flips and App.svelte dispatches the theme-changed StateEffect.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'dark');

  // The diagram re-renders for the new theme: a fresh render id replaces the old.
  await expect(async () => {
    const darkId = await editor.locator('.cm-mermaid svg').getAttribute('id');
    expect(darkId).toBeTruthy();
    expect(darkId).not.toBe(lightId);
  }).toPass({ timeout: 15000 });

  await page.screenshot({
    path: 'tests/screenshots/mermaid-theme-sync.png',
    fullPage: true,
  });
});
