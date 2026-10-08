import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, expect } from './fixtures';
import { WEB_APPEARANCE_CONFIG } from './web-bundle';

/**
 * Colours and fonts on Sunstone Web (`SUNSTONE_CONFIG`, read per request by
 * `sunstone-server`, inlined into the SSR `<head>` by `hooks.server.ts`).
 *
 * The server is started pointing at a config path that normally does not
 * exist (= the default look for every other web spec); this spec writes it,
 * plus a font file beside it, and removes both afterwards.
 */

const DIR = dirname(WEB_APPEARANCE_CONFIG);
const WOFF2 = readFileSync('node_modules/@fontsource-variable/jost/files/jost-latin-wght-normal.woff2');

test.beforeEach(() => {
  mkdirSync(join(DIR, 'fonts'), { recursive: true });
  writeFileSync(join(DIR, 'fonts', 'Reader.woff2'), WOFF2);
  writeFileSync(
    WEB_APPEARANCE_CONFIG,
    JSON.stringify({
      colors: { light: { accent: '#2b7fd9' } },
      fonts: {
        ui: { family: 'Georgia, serif', size: 18 },
        content: { family: 'serif', size: 20, files: ['fonts/Reader.woff2'] },
      },
    }),
  );
});

test.afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

test('the SSR page already carries the configured colours and fonts', async ({ page, request }) => {
  // The raw HTML, before any script runs.
  const html = await (await request.get('/')).text();
  expect(html).toContain('<style id="sunstone-appearance">');
  expect(html).toContain('--font-content-size: 20px;');
  expect(html).toContain('--accent: #2b7fd9;');

  await page.goto('/');
  await expect(page.getByTestId('web-viewer')).toBeVisible();
  await expect(page.locator('html')).toHaveCSS('font-size', '18px');
  const reader = await page.locator('.rendered').first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { family: s.fontFamily, size: s.fontSize };
  });
  expect(reader).toEqual({ family: '"Sunstone Content", serif', size: '20px' });
  await expect
    .poll(() => page.evaluate(() => document.fonts.check('20px "Sunstone Content"')))
    .toBe(true);
});

test('only font files the config lists are served', async ({ request }) => {
  const ok = await request.get('/_api/appearance/font?file=fonts%2FReader.woff2');
  expect(ok.status()).toBe(200);
  expect(ok.headers()['content-type']).toBe('font/woff2');
  expect((await request.get('/_api/appearance/font?file=config.json')).status()).toBe(404);
  expect((await request.get('/_api/appearance/font?file=..%2Fx.woff2')).status()).toBe(400);
});

test('without a config the page keeps the default look', async ({ request }) => {
  rmSync(DIR, { recursive: true, force: true });
  expect(await (await request.get('/_api/appearance')).json()).toBeNull();
  expect(await (await request.get('/')).text()).not.toContain('sunstone-appearance');
});
