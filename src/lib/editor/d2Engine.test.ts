// Unit tests for the engine-agnostic D2 compile + render half (dr-3).
import { describe, expect, test } from 'bun:test';
import {
  D2_PAD,
  compileAndRender,
  d2RenderOptions,
  formatD2Error,
  serialQueue,
  type D2Like,
  type D2RenderOptions,
} from './d2Engine';

describe('d2RenderOptions', () => {
  test('forces the palette, salt and embedding; keeps what the source asked for', () => {
    const fromSource: D2RenderOptions = {
      sketch: true,
      center: true,
      themeID: 200,
      darkThemeID: 201,
      themeOverrides: { N1: '#fff' },
      pad: 100,
      salt: null,
    };
    const options = d2RenderOptions(fromSource, 'cm-d2-7');
    expect(options.sketch).toBe(true);
    expect(options.center).toBe(true);
    expect(options.themeID).toBe(0);
    expect(options.darkThemeID).toBeNull();
    expect(options.themeOverrides).toBeNull();
    expect(options.darkThemeOverrides).toBeNull();
    expect(options.salt).toBe('cm-d2-7');
    expect(options.noXMLTag).toBe(true);
    expect(options.pad).toBe(D2_PAD);
    expect(options.scale).toBe(1);
    expect(options.forceAppendix).toBe(false);
  });
});

describe('formatD2Error', () => {
  test("turns D2's JSON diagnostics into one line each", () => {
    const raw = JSON.stringify([
      { range: 'index,0:0:0-0:5:5', errmsg: 'index:1:1: connection missing destination' },
      { range: 'index,0:5:5-0:6:6', errmsg: 'index:1:6: maps must be terminated with }' },
    ]);
    expect(formatD2Error(raw)).toBe(
      'index:1:1: connection missing destination\nindex:1:6: maps must be terminated with }',
    );
  });

  test('passes plain and unparseable messages through', () => {
    expect(formatD2Error('D2 failed to start')).toBe('D2 failed to start');
    expect(formatD2Error('[not json')).toBe('[not json');
    expect(formatD2Error('[]')).toBe('[]');
  });
});

/** A stub engine recording what it was asked to render. */
function stubD2(fail?: string): D2Like & { rendered: D2RenderOptions[] } {
  const stub = {
    rendered: [] as D2RenderOptions[],
    async compile(source: string) {
      if (fail) throw new Error(fail);
      return { diagram: { source }, renderOptions: { sketch: false, themeID: 3 } };
    },
    async render(diagram: unknown, options: D2RenderOptions) {
      stub.rendered.push(options);
      return `<svg data-src="${(diagram as { source: string }).source}"/>`;
    },
  };
  return stub;
}

describe('compileAndRender', () => {
  test('renders the compiled diagram with the forced options', async () => {
    const d2 = stubD2();
    expect(await compileAndRender(d2, 'a -> b', 'web-d2-1')).toBe('<svg data-src="a -> b"/>');
    expect(d2.rendered[0].salt).toBe('web-d2-1');
    expect(d2.rendered[0].themeID).toBe(0);
  });

  test('rejects with the formatted compile error', async () => {
    const d2 = stubD2(JSON.stringify([{ errmsg: 'index:1:6: boom' }]));
    await expect(compileAndRender(d2, 'a -> {', 's')).rejects.toThrow('index:1:6: boom');
  });
});

describe('serialQueue', () => {
  test('runs tasks one at a time, in order, past a failure', async () => {
    const enqueue = serialQueue();
    const log: string[] = [];
    let running = 0;
    const task = (name: string, fail = false) => async () => {
      running++;
      expect(running).toBe(1);
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`end ${name}`);
      running--;
      if (fail) throw new Error(name);
      return name;
    };
    const results = await Promise.allSettled([
      enqueue(task('a')),
      enqueue(task('b', true)),
      enqueue(task('c')),
    ]);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
