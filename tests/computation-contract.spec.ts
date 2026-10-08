import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * ov-12: an Attested Computation's contract card. A Concept whose `type` is
 * `Attested Computation` shows its `runtime`, `parameters`, `computation`,
 * `executor` (with `receipt`) and `attester` above the body; the path-valued
 * fields open like any in-Bundle link; the card follows the YAML as it is
 * edited and is never written to the file. Driven against the fake backend.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

const PROBE = 'computation-probe.md';

const CONTENT =
  '---\ntype: Attested Computation\nruntime: bigquery\nparameters:\n' +
  '  - { name: year, type: integer, required: true }\n  - { name: region, type: string }\n' +
  'executor:\n  resource: concepts/bundle.md\n  receipt: [job_id, executed_sql]\n' +
  'attester:\n  resource: /concepts/codemirror.md\n---\n\nComputation probe body.\n';

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
  await expect(editor).toContainText('Computation probe body.');
  return editor;
}

test('contract card: runtime, parameters, executor with receipt, attester', async ({ page }) => {
  const editor = await openProbe(page, CONTENT);
  const card = editor.getByTestId('computation');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.computation-runtime')).toHaveText('bigquery');
  const params = card.locator('.computation-params li');
  await expect(params).toHaveCount(2);
  await expect(params.nth(0)).toHaveText('year integer required');
  await expect(params.nth(1)).toHaveText('region string');
  await expect(card.locator('.computation-receipt code')).toHaveText(['job_id', 'executed_sql']);
  await expect(card.locator('a[data-resource]')).toHaveText(['concepts/bundle.md', '/concepts/codemirror.md']);
  // Above the body, not part of the document, and nothing to run it with.
  await expect(editor.locator('.cm-content > :first-child')).toHaveClass(/cm-computation/);
  await expect(editor.locator('.cm-line', { hasText: 'bigquery' })).toHaveCount(0);
  await expect(card.locator('button')).toHaveCount(0);
});

test('contract card: path-valued fields open like in-Bundle links', async ({ page }) => {
  const editor = await openProbe(page, CONTENT);
  const card = editor.getByTestId('computation');
  await card.locator('a[data-resource="concepts/bundle.md"]').click();
  await expect(editor).toContainText('A Bundle is the root folder opened by Sunstone');
  await expect(editor).not.toContainText('Computation probe body.');

  await page.getByTestId('tree').locator(`[data-path="${PROBE}"]`).click();
  await expect(editor).toContainText('Computation probe body.');
  // Bundle-absolute: under the detected root.
  await editor.getByTestId('computation').locator('a[data-resource="/concepts/codemirror.md"]').click();
  await expect(editor).toContainText('CodeMirror 6 is the editor core.');
});

test('contract card: follows the YAML as edited; another type has none', async ({ page }) => {
  const editor = await openProbe(page, '---\ntype: Metric\nruntime: python\n---\n\nComputation probe body.\n');
  await expect(editor.getByTestId('computation')).toHaveCount(0);

  await page.getByTestId('frontmatter-toggle').click();
  await page.getByTestId('edit-toggle').click();
  const yaml = page.getByTestId('frontmatter').locator('.cm-content');
  await expect(yaml).toContainText('type: Metric');
  await yaml.locator('.cm-line', { hasText: 'type: Metric' }).click();
  await page.keyboard.press('End');
  for (const _ of 'Metric') await page.keyboard.press('Backspace');
  await page.keyboard.type('Attested Computation');
  const card = editor.getByTestId('computation');
  await expect(card.locator('.computation-runtime')).toHaveText('python');

  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nexecutor:\n  receipt: [result]');
  await expect(card.locator('.computation-receipt code')).toHaveText(['result']);

  // Only the YAML is written.
  await expect
    .poll(() => page.evaluate((p) => (window as unknown as FakeWindow).__sunstoneFake.files[p], PROBE))
    .toContain('receipt: [result]');
  const saved = await page.evaluate((p) => (window as unknown as FakeWindow).__sunstoneFake.files[p], PROBE);
  expect(saved).not.toContain('computation-');
});

test('contract card: follows the trust line', async ({ page }) => {
  const editor = await openProbe(page, CONTENT.replace('runtime:', 'verified: { by: human:a }\nruntime:'));
  await expect(editor.locator('.cm-content > :nth-child(1)')).toHaveClass(/cm-trust/);
  await expect(editor.locator('.cm-content > :nth-child(2)')).toHaveClass(/cm-computation/);
});
