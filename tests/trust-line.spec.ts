import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * ov-9: the trust line. A Concept's `generated` / `verified` Frontmatter (or a
 * legacy `timestamp`) shows as one line above the body with the derived trust
 * tier first; it follows the YAML as it is edited and is never written to the
 * file. Driven against the fake backend.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

const PROBE = 'trust-probe.md';

async function openProbe(page: Page, content: string) {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate(
    ([p, c]) => (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('created', p, c),
    [PROBE, content] as const,
  );
  await tree.locator(`[data-path="${PROBE}"]`).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Trust probe body.');
  return editor;
}

test('trust line: tier, generator and verifiers; a bare verified mapping is one event', async ({
  page,
}) => {
  const editor = await openProbe(
    page,
    '---\ntype: x\ngenerated: { by: acme/agent/1.2, at: 2026-06-20T22:53:05Z }\n' +
      'verified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }\n---\n\nTrust probe body.\n',
  );
  const line = editor.getByTestId('trust');
  await expect(line).toHaveCount(1);
  await expect(line.locator('.trust-tier')).toHaveText('Human-reviewed');
  const gen = line.locator('.trust-generated');
  await expect(gen.locator('.actor-agent .actor-id')).toHaveText('acme/agent');
  await expect(gen.locator('.actor-agent .actor-version')).toHaveText('1.2');
  await expect(gen.locator('time')).toHaveText('2026-06-20');
  await expect(gen.locator('time')).toHaveAttribute('title', '2026-06-20T22:53:05Z');
  const events = line.locator('.trust-event');
  await expect(events).toHaveCount(1);
  await expect(events.locator('.actor-human .actor-id')).toHaveText('ahormati');
  // The line sits above the body and is not part of the document.
  await expect(editor.locator('.cm-content > :first-child')).toHaveClass(/cm-trust/);
  await expect(editor.locator('.cm-line', { hasText: 'Human-reviewed' })).toHaveCount(0);
});

test('trust line: adding and removing a verification event re-derives the tier', async ({ page }) => {
  const content =
    '---\ntype: x\ngenerated: { by: acme/agent/1.2, at: 2026-06-20T22:53:05Z }\n---\n\nTrust probe body.\n';
  const editor = await openProbe(page, content);
  const tier = editor.getByTestId('trust').locator('.trust-tier');
  await expect(tier).toHaveText('Unverified');

  await page.getByTestId('frontmatter-toggle').click();
  await page.getByTestId('edit-toggle').click();
  const yaml = page.getByTestId('frontmatter').locator('.cm-content');
  await expect(yaml).toContainText('generated:');
  await yaml.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nverified: [{ by: process:nightly, at: 2026-06-26T02:00:00Z }]');
  await expect(tier).toHaveText('Machine-confirmed');

  // A person's sign-off lifts it; taking it out drops it again.
  const human = ', { by: human:ahormati, at: 2026-06-25T09:00:00Z }';
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type(human);
  await expect(tier).toHaveText('Human-reviewed');
  await expect(editor.locator('.trust-event')).toHaveCount(2);
  for (const _ of human) await page.keyboard.press('Backspace');
  await expect(tier).toHaveText('Machine-confirmed');

  // Only the YAML is written: the tier is derived, never stored.
  await expect
    .poll(() => page.evaluate((p) => (window as unknown as FakeWindow).__sunstoneFake.files[p], PROBE))
    .toContain('verified: [{ by: process:nightly, at: 2026-06-26T02:00:00Z }]');
  const saved = await page.evaluate((p) => (window as unknown as FakeWindow).__sunstoneFake.files[p], PROBE);
  expect(saved).not.toMatch(/tier|Machine-confirmed/i);
});

test('trust line: a generated block without by degrades visibly', async ({ page }) => {
  const editor = await openProbe(page, '---\ntype: x\ngenerated:\n  at: 2026-06-20\n---\n\nTrust probe body.\n');
  const line = editor.getByTestId('trust');
  await expect(line.locator('.trust-tier')).toHaveText('Unverified');
  await expect(line.locator('.trust-missing')).toHaveText('by unknown');
  // Not ISO with an offset: shown as written.
  await expect(line.locator('time')).toHaveText('2026-06-20');
});

test('trust line: a legacy timestamp is the generation time; no keys, no line', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  const editor = page.getByTestId('editor');

  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(editor).toContainText('CodeMirror 6 is the editor core.');
  const line = editor.getByTestId('trust');
  await expect(line).toHaveText('Generated 2026-06-15');
  await expect(line.locator('.trust-tier')).toHaveCount(0);

  await tree.locator('[data-path="concepts/bundle.md"]').click();
  await expect(editor).toContainText('Bundle');
  await expect(editor.getByTestId('trust')).toHaveCount(0);
});
