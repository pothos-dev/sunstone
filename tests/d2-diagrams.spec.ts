import { test, expect, type Page } from './fixtures';

/**
 * dr-3: ```d2 fences render as Diagrams on the diagram seam (ADR-0014), in the
 * app palette.
 *
 * Mirrors the `mermaid-*` specs (render, edit affordance, error state, theme
 * sync) and adds what is D2's own: the engine loads lazily in a Web Worker,
 * the palette comes from a stylesheet (so a theme flip recolours with no
 * re-render), authored colours and `theme-id` behave as the effort decided,
 * icons never reach the network, and per-render salts keep two diagrams' ids
 * apart.
 *
 * Each test seeds its own probe Concept through the fake backend's
 * `simulateExternalChange`, so the shared fixture tree (which other specs
 * navigate by position) stays untouched. D2 is ~8 MB and renders in a worker,
 * so assertions poll with a generous timeout.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
  };
};

const PROBE = 'concepts/d2-probe.md';
const RENDER_TIMEOUT = 30_000;

/** A small architecture: services in a container, a database, labelled edges. */
const ARCHITECTURE = `direction: right
reader: Reader { shape: person }
platform: Platform {
  web: Web app
  api: API gateway
  auth: Auth service
  web -> api: HTTPS
  api -> auth: verify token
}
db: Postgres { shape: cylinder }
queue: Job queue { shape: queue }
reader -> platform.web: browse
platform.api -> db: SQL
platform.api -> queue: enqueue`;

const fence = (source: string) => '```d2\n' + source + '\n```';

function concept(...blocks: string[]): string {
  return `---\ntype: concept\ntitle: D2 probe\n---\n\n# D2 probe\n\nIntro line above the diagrams.\n\n${blocks.join('\n\nBetween the diagrams.\n\n')}\n\nOutro line below the diagrams.\n`;
}

/** Seed the probe Concept, open it, and return the editor. */
async function openProbe(page: Page, content: string, mode: 'read' | 'editing' = 'read') {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate(
    ([p, c]) =>
      (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('created', p, c),
    [PROBE, content] as const,
  );
  await tree.locator(`[data-path="${PROBE}"]`).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Intro line above the diagrams.');
  if (mode === 'editing') await page.getByTestId('edit-toggle').click();
  return editor;
}

/** Resolve an app custom property on the editor root as the browser paints it. */
async function resolvedVar(page: Page, name: string): Promise<string> {
  return page.getByTestId('editor').evaluate((el, n) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${n})`;
    el.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

/** The computed `fill`/`stroke` of the first element matching `selector` in the D2 SVG. */
async function paint(page: Page, selector: string, property: 'fill' | 'stroke'): Promise<string> {
  return page
    .locator(`.cm-d2 svg.d2-svg ${selector}`)
    .first()
    .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
}

test('d2: a fence renders as an SVG diagram in read and editing; the cursor reveals the source', async ({
  page,
}) => {
  const workerRequests: string[] = [];
  page.on('request', (request) => {
    if (/d2Worker/.test(request.url())) workerRequests.push(request.url());
  });

  // A Concept without a D2 fence never fetches the engine.
  await page.goto('/');
  await page.getByTestId('tree').locator('[data-path="concepts/editor/live-preview.md"]').click();
  await expect(page.locator('.cm-mermaid svg')).toHaveCount(0); // not scrolled to it
  await page.waitForTimeout(500);
  expect(workerRequests).toEqual([]);

  const editor = await openProbe(page, concept(fence(ARCHITECTURE)), 'editing');

  // Editing: the diagram renders while the caret is outside the fence.
  const diagram = editor.locator('.cm-d2 svg.d2-svg');
  await expect(diagram).toBeVisible({ timeout: RENDER_TIMEOUT });
  await expect(diagram.locator('text', { hasText: 'API gateway' })).toBeVisible();
  // The engine came from its own worker chunk, fetched on demand.
  expect(workerRequests.length).toBe(1);
  // A click lands the caret in the fence and lifts the block-replace.
  await diagram.click();
  await expect(editor).toContainText('platform.api -> db');

  // Read mode always renders, and a click never reveals the source.
  await page.getByTestId('edit-toggle').click();
  await expect(diagram).toBeVisible({ timeout: RENDER_TIMEOUT });
  await expect(editor).not.toContainText('platform.api -> db');
  await diagram.click();
  await expect(editor).not.toContainText('platform.api -> db');
});

test('d2: editing mode offers the hover hint and double-click to edit', async ({ page }) => {
  const editor = await openProbe(page, concept(fence('a -> b: hello')), 'editing');
  const wrap = editor.locator('.cm-d2-editable');
  await expect(wrap.locator('svg.d2-svg')).toBeVisible({ timeout: RENDER_TIMEOUT });
  await expect(wrap).toHaveAttribute('title', 'Click to edit diagram');
  await expect(wrap).toHaveCSS('cursor', 'pointer');
  await wrap.hover();
  await expect(editor.locator('.cm-d2-edit-hint')).toBeVisible();
  // The double-click handler alone lifts the replace. (A real double-click's
  // first click already reveals the short source, and its second then lands
  // below it, so drive the handler directly.)
  await wrap.dispatchEvent('dblclick');
  await expect(editor).toContainText('a -> b: hello');
});

test("d2: a compile error shows the shared error panel with D2's message", async ({ page }) => {
  const editor = await openProbe(page, concept(fence('a -> {')));
  const panel = editor.locator('.cm-diagram-error.cm-d2-error');
  await expect(panel).toBeVisible({ timeout: RENDER_TIMEOUT });
  await expect(editor.locator('.cm-d2-error-heading')).toHaveText('Diagram error');
  // D2's own diagnostic, one per line, not its JSON envelope.
  await expect(editor.locator('.cm-d2-error-message')).toContainText(
    'maps must be terminated with }',
  );
  await expect(editor.locator('.cm-d2-error-message')).not.toContainText('errmsg');
  await expect(editor.locator('.cm-d2-error-source')).toContainText('a -> {');
});

test('d2: themed elements take the app palette and follow a theme flip without re-rendering', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const editor = await openProbe(page, concept(fence(ARCHITECTURE)));
  const diagram = editor.locator('.cm-d2 svg.d2-svg');
  await expect(diagram).toBeVisible({ timeout: RENDER_TIMEOUT });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'light');

  const expectPalette = async () => {
    // Top-level shapes on the elevated surface, labels in the text colour,
    // connections and their arrowheads muted, the container sunken.
    expect(await paint(page, 'rect.fill-B5', 'fill')).toBe(await resolvedVar(page, '--bg-elevated'));
    expect(await paint(page, 'text.fill-N1', 'fill')).toBe(await resolvedVar(page, '--text'));
    expect(await paint(page, 'path.connection.stroke-B1', 'stroke')).toBe(
      await resolvedVar(page, '--text-muted'),
    );
    expect(await paint(page, '.connection.fill-B1', 'fill')).toBe(await resolvedVar(page, '--text-muted'));
    expect(await paint(page, 'rect.fill-B4', 'fill')).toBe(await resolvedVar(page, '--bg-sunken'));
    // The diagram background is transparent: it sits on the page.
    expect(await paint(page, '> rect.fill-N7', 'fill')).toBe('rgba(0, 0, 0, 0)');
  };
  await expectPalette();

  // D2's per-diagram scoping class carries the render's salt: a re-render
  // would mint a new one.
  const scopeClass = await diagram.getAttribute('class');
  const lightText = await resolvedVar(page, '--text');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'dark');
  await expect(editor.locator('.cm-d2 svg.d2-svg')).toBeVisible();
  expect(await resolvedVar(page, '--text')).not.toBe(lightText);
  await expectPalette();
  expect(await editor.locator('.cm-d2 svg.d2-svg').getAttribute('class')).toBe(scopeClass);
});

test('d2: authored colours stay as written in both themes; theme-id is ignored', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const source = `vars: {
  d2-config: {
    theme-id: 200
  }
}
alert: Alert { style.fill: "#c62828"; style.font-color: "#ffffff" }
plain: Plain
plain -> alert`;
  const editor = await openProbe(page, concept(fence(source)));
  await expect(editor.locator('.cm-d2 svg.d2-svg')).toBeVisible({ timeout: RENDER_TIMEOUT });

  const alertFill = () =>
    editor
      .locator('.cm-d2 svg.d2-svg rect[fill="#c62828"]')
      .evaluate((el) => getComputedStyle(el).fill);
  expect(await alertFill()).toBe('rgb(198, 40, 40)');
  // theme-id 200 (a dark D2 theme) does not leak: the plain shape is the app surface.
  expect(await paint(page, 'rect.fill-B6', 'fill')).toBe(await resolvedVar(page, '--bg-elevated'));

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'dark');
  expect(await alertFill()).toBe('rgb(198, 40, 40)');
  expect(await paint(page, 'rect.fill-B6', 'fill')).toBe(await resolvedVar(page, '--bg-elevated'));
});

test('d2: icons are stripped and never fetched; two diagrams keep their ids apart', async ({
  page,
}) => {
  const iconRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('icons.terrastruct.com')) iconRequests.push(request.url());
  });
  const withIcon = `monitor: Monitor { icon: https://icons.terrastruct.com/essentials/087-display.svg }
monitor -> pager: alerts`;
  const editor = await openProbe(page, concept(fence(ARCHITECTURE), fence(withIcon)));

  const diagrams = editor.locator('.cm-d2 svg.d2-svg');
  await expect(diagrams).toHaveCount(2, { timeout: RENDER_TIMEOUT });
  await expect(diagrams.nth(1).locator('text', { hasText: 'Monitor' })).toBeVisible();
  // The icon `<image>` is gone and nothing asked the network for it.
  await expect(editor.locator('.cm-d2 image')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(iconRequests).toEqual([]);

  // Each diagram's marker and mask references resolve inside its OWN svg, and
  // the two diagrams share no id.
  const report = await editor.evaluate((root) => {
    const svgs = Array.from(root.querySelectorAll('.cm-d2 svg.d2-svg'));
    const ids = svgs.map((svg) => Array.from(svg.querySelectorAll('[id]')).map((el) => el.id));
    const dangling = svgs.flatMap((svg) =>
      Array.from(svg.querySelectorAll('[marker-end], [mask]')).flatMap((el) =>
        ['marker-end', 'mask']
          .map((attr) => el.getAttribute(attr)?.match(/url\(#([^)]+)\)/)?.[1])
          .filter((id): id is string => !!id && !svg.querySelector(`[id="${id}"]`)),
      ),
    );
    return { ids, dangling };
  });
  expect(report.ids[0].length).toBeGreaterThan(0);
  expect(report.ids[0].filter((id) => report.ids[1].includes(id))).toEqual([]);
  expect(report.dangling).toEqual([]);
});

test('d2: screenshot an architecture diagram in light and dark', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  const editor = await openProbe(page, concept(fence(ARCHITECTURE)));
  const block = editor.locator('.cm-d2').first();
  await expect(block.locator('svg.d2-svg')).toBeVisible({ timeout: RENDER_TIMEOUT });
  await page.screenshot({ path: 'tests/screenshots/d2-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'tests/screenshots/d2-dark.png' });
});
