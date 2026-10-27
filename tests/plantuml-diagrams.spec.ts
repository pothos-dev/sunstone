import { test, expect, type Page } from './fixtures';

/**
 * dr-4: ```plantuml fences render as Diagrams on the diagram seam (ADR-0016),
 * in the app palette.
 *
 * Mirrors `d2-diagrams.spec.ts` (render, edit affordance, error state, theme
 * sync) and adds what is PlantUML's own: a bare body is wrapped in
 * `@startuml`, the palette is a `<style>` preamble baked in at render time (so
 * a theme flip re-renders), the engine's error picture becomes the error
 * panel's text, and the engine never loads a script or reaches the network.
 *
 * Each test seeds its own probe Concept through the fake backend's
 * `simulateExternalChange`, so the shared fixture tree stays untouched.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
  };
};

const PROBE = 'concepts/plantuml-probe.md';
const RENDER_TIMEOUT = 30_000;

/** A small sequence: participants, a note, a reply. */
const SEQUENCE = `@startuml
actor Reader
participant "API gateway" as Api
database Postgres
Reader -> Api : GET /concepts
Api -> Postgres : SQL
note right of Postgres : read replica
Postgres --> Api : rows
Api --> Reader : 200 OK
@enduml`;

/** Classes in a package, the stereotype circles and a relation. */
const CLASSES = `class Bundle {
  +root: Path
  +concepts(): List
}
package model {
  class Concept
  interface Linkable
}
Bundle "1" *-- "many" Concept
Concept ..|> Linkable`;

const fence = (source: string) => '```plantuml\n' + source + '\n```';

function concept(...blocks: string[]): string {
  return `---\ntype: concept\ntitle: PlantUML probe\n---\n\n# PlantUML probe\n\nIntro line above the diagrams.\n\n${blocks.join('\n\nBetween the diagrams.\n\n')}\n\nOutro line below the diagrams.\n`;
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

/** The computed `fill`/`stroke` of the first element matching `selector` in the first diagram. */
async function paint(page: Page, selector: string, property: 'fill' | 'stroke'): Promise<string> {
  return page
    .locator(`.cm-plantuml svg ${selector}`)
    .first()
    .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
}

/** Whether the engine has been loaded into the page. */
const engineLoaded = (page: Page) => page.evaluate(() => '__pl_script_state' in window);

test('plantuml: a fence renders as an SVG diagram in read and editing; the cursor reveals the source', async ({
  page,
}) => {
  // A Concept without a PlantUML fence never loads the engine.
  await page.goto('/');
  await page.getByTestId('tree').locator('[data-path="concepts/editor/live-preview.md"]').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.waitForTimeout(500);
  expect(await engineLoaded(page)).toBe(false);

  const editor = await openProbe(page, concept(fence(SEQUENCE)), 'editing');

  // Editing: the diagram renders while the caret is outside the fence.
  const diagram = editor.locator('.cm-plantuml svg');
  await expect(diagram).toBeVisible({ timeout: RENDER_TIMEOUT });
  await expect(diagram.locator('text', { hasText: 'API gateway' }).first()).toBeVisible();
  expect(await engineLoaded(page)).toBe(true);
  // A click lands the caret in the fence and lifts the block-replace.
  await diagram.click();
  await expect(editor).toContainText('Reader -> Api : GET /concepts');

  // Read mode always renders, and a click never reveals the source.
  await page.getByTestId('edit-toggle').click();
  await expect(diagram).toBeVisible({ timeout: RENDER_TIMEOUT });
  await expect(editor).not.toContainText('Reader -> Api : GET /concepts');
  await diagram.click();
  await expect(editor).not.toContainText('Reader -> Api : GET /concepts');
});

test('plantuml: a bare body without @startuml renders; editing offers hover hint and double-click', async ({
  page,
}) => {
  const editor = await openProbe(page, concept(fence('Alice -> Bob : hello')), 'editing');
  const wrap = editor.locator('.cm-plantuml-editable');
  await expect(wrap.locator('svg')).toBeVisible({ timeout: RENDER_TIMEOUT });
  await expect(wrap.locator('svg text', { hasText: 'hello' })).toBeVisible();
  await expect(wrap).toHaveAttribute('title', 'Click to edit diagram');
  await wrap.hover();
  await expect(editor.locator('.cm-plantuml-edit-hint')).toBeVisible();
  await wrap.dispatchEvent('dblclick');
  await expect(editor).toContainText('Alice -> Bob : hello');
});

test("plantuml: a syntax error shows the shared error panel with PlantUML's message at the fence line", async ({
  page,
}) => {
  const editor = await openProbe(
    page,
    concept(fence('@startuml\nAlice -> Bob : fine\nfoo bar baz (((\n@enduml')),
  );
  const panel = editor.locator('.cm-diagram-error.cm-plantuml-error');
  await expect(panel).toBeVisible({ timeout: RENDER_TIMEOUT });
  await expect(editor.locator('.cm-plantuml-error-heading')).toHaveText('Diagram error');
  // Line 3 of the fence, not of the engine input with the palette preamble.
  await expect(editor.locator('.cm-plantuml-error-message')).toHaveText(/^line 3: Syntax Error\?/);
  await expect(editor.locator('.cm-plantuml-error-source')).toContainText('foo bar baz (((');
  // No picture of the error leaks through as a diagram.
  await expect(editor.locator('.cm-plantuml svg')).toHaveCount(0);
});

test('plantuml: themed elements take the app palette and a theme flip re-renders in the new one', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const editor = await openProbe(page, concept(fence(CLASSES)));
  await expect(editor.locator('.cm-plantuml svg')).toBeVisible({ timeout: RENDER_TIMEOUT });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'light');

  const expectPalette = async () => {
    // Class boxes on the elevated surface, labels in the text colour, the
    // package sunken, relations muted, and the background transparent.
    expect(await paint(page, 'g.entity[data-qualified-name="Bundle"] rect', 'fill')).toBe(
      await resolvedVar(page, '--bg-elevated'),
    );
    expect(await paint(page, 'g.entity[data-qualified-name="Bundle"] text', 'fill')).toBe(
      await resolvedVar(page, '--text'),
    );
    expect(await paint(page, 'g.cluster path, g.cluster rect', 'fill')).toBe(
      await resolvedVar(page, '--bg-sunken'),
    );
    expect(await paint(page, 'g.link path', 'stroke')).toBe(await resolvedVar(page, '--text-muted'));
    expect(
      await page.locator('.cm-plantuml svg text').first().evaluate((el) => getComputedStyle(el).fontFamily),
    ).toContain('Jost');
  };
  await expectPalette();
  const lightText = await resolvedVar(page, '--text');

  // Labels fit their boxes: the SVG text is painted at the weight and spacing
  // PlantUML measured it with, not the editor's inherited ones.
  const overflow = await page
    .locator('.cm-plantuml svg g.entity[data-qualified-name="Bundle"]')
    .evaluate((entity) => {
      const box = (entity.querySelector('rect') as SVGGraphicsElement).getBBox();
      return Array.from(entity.querySelectorAll('text')).map((text) => {
        const b = (text as SVGGraphicsElement).getBBox();
        return Math.max(0, b.x + b.width - (box.x + box.width));
      });
    });
  expect(Math.max(...overflow)).toBeLessThan(1);
  // The stereotype letter keeps the attribute that centres it in its circle.
  await expect(
    page.locator('.cm-plantuml svg g.entity[data-qualified-name="Bundle"] text[dominant-baseline="central"]'),
  ).toHaveCount(1);

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'dark');
  expect(await resolvedVar(page, '--text')).not.toBe(lightText);
  // The colours are baked in, so the flip re-renders; wait for the new SVG.
  await expect
    .poll(() => paint(page, 'g.entity[data-qualified-name="Bundle"] text', 'fill'), {
      timeout: RENDER_TIMEOUT,
    })
    .not.toBe(lightText);
  await expectPalette();
});

test('plantuml: authored colours stay as written in both themes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const editor = await openProbe(page, concept(fence('class Alert #c62828\nclass Plain\nPlain --> Alert')));
  await expect(editor.locator('.cm-plantuml svg')).toBeVisible({ timeout: RENDER_TIMEOUT });
  const alertFill = () =>
    paint(page, 'g.entity[data-qualified-name="Alert"] rect', 'fill');
  expect(await alertFill()).toBe('rgb(198, 40, 40)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'dark');
  const darkSurface = await resolvedVar(page, '--bg-elevated');
  await expect
    .poll(() => paint(page, 'g.entity[data-qualified-name="Plain"] rect', 'fill'), {
      timeout: RENDER_TIMEOUT,
    })
    .toBe(darkSurface);
  expect(await alertFill()).toBe('rgb(198, 40, 40)');
});

test('plantuml: icons and emoji render from the bundle; nothing loads a script or reaches the network', async ({
  page,
}) => {
  const origin = new URL(page.url() === 'about:blank' ? 'http://localhost:1420' : page.url()).origin;
  const suspicious: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin && url.protocol.startsWith('http')) suspicious.push(request.url());
    if (/(^|\/)(openiconic|emoji|[a-z0-9_-]+\.min)\.js$/i.test(url.pathname)) suspicious.push(request.url());
  });

  const editor = await openProbe(
    page,
    concept(
      fence('Alice -> Bob : <&star> starred\nBob -> Alice : <:smile:> smiled'),
      fence('class Linked [[https://example.com/tracker]]\nAlice -> Bob : <img:https://example.com/x.png>'),
      fence('!include <C4/C4_Container>\nPerson(a, "A")'),
      fence('!include https://example.com/remote.puml\nAlice -> Bob'),
    ),
  );

  const diagrams = editor.locator('.cm-plantuml svg');
  await expect(diagrams).toHaveCount(2, { timeout: RENDER_TIMEOUT });
  // The icon and the emoji are drawn as paths, from tables bundled with the app.
  await expect(diagrams.nth(0).locator('text', { hasText: 'starred' })).toBeVisible();
  expect(await diagrams.nth(0).locator('path').count()).toBeGreaterThan(2);
  // The link and the remote image are stripped by the sanitiser.
  await expect(diagrams.nth(1).locator('[href^="http"]')).toHaveCount(0);
  await expect(diagrams.nth(1).locator('image')).toHaveCount(0);

  // The standard library is not shipped, and remote includes are refused.
  const errors = editor.locator('.cm-plantuml-error-message');
  await expect(errors).toHaveCount(2, { timeout: RENDER_TIMEOUT });
  await expect(errors.nth(0)).toContainText('cannot include <C4/C4_Container>');
  await expect(errors.nth(1)).toContainText('line 1:');

  await page.waitForTimeout(500);
  expect(suspicious).toEqual([]);
});

test('plantuml: screenshot a sequence and a class diagram in light and dark', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  const editor = await openProbe(page, concept(fence(SEQUENCE), fence(CLASSES)));
  await expect(editor.locator('.cm-plantuml svg')).toHaveCount(2, { timeout: RENDER_TIMEOUT });
  await page.screenshot({ path: 'tests/screenshots/plantuml-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'dark');
  await expect
    .poll(() => paint(page, 'text', 'fill'), { timeout: RENDER_TIMEOUT })
    .toBe(await resolvedVar(page, '--text'));
  await page.screenshot({ path: 'tests/screenshots/plantuml-dark.png' });
});
