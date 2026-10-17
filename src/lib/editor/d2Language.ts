// D2, the second language on the diagram seam (dr-3, ADR-0014).
//
// The engine is `@terrastruct/d2` (D2's official WASM build), run in a Web
// Worker (`d2Worker.ts`) that is only spawned the first time a ` ```d2 ` fence
// renders, so neither shell pays for its ~8 MB until a document needs it.
// Its output is author-controlled SVG, so it goes through dr-2's sanitiser.
// It is themed by `d2Theme.ts`'s stylesheet, not at render time: a rendered
// SVG is the same in both themes, and a theme flip repaints it from the cache.

import type { DiagramLanguage, DiagramRenderer } from './diagramLanguage';
import type { D2WorkerRequest, D2WorkerResponse } from './d2Worker';
import { d2Stylesheet } from './d2Theme';
import { sanitiseSvg } from '../svg/sanitiseSvg';

/**
 * Start the D2 worker and resolve once its engine is up. Requests carry an id,
 * so their replies can arrive in any order (the worker answers in order).
 */
function loadD2(): Promise<DiagramRenderer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./d2Worker.ts', import.meta.url), { type: 'module' });
    const pending = new Map<number, { resolve: (svg: string) => void; reject: (e: Error) => void }>();
    let nextId = 0;

    const render: DiagramRenderer = ({ source, renderId }) =>
      new Promise<string>((resolveRender, rejectRender) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveRender, reject: rejectRender });
        const request: D2WorkerRequest = { id, source, salt: renderId };
        worker.postMessage(request);
      });

    worker.onmessage = ({ data }: MessageEvent<D2WorkerResponse>) => {
      if ('type' in data) {
        if (data.type === 'ready') resolve(render);
        else reject(new Error(`D2 failed to start: ${data.message}`));
        return;
      }
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if ('svg' in data) entry.resolve(data.svg);
      else entry.reject(new Error(data.error));
    };
    worker.onerror = (event) => {
      const error = new Error(`D2 failed to start: ${event.message || 'worker error'}`);
      reject(error);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
  });
}

export const d2Language: DiagramLanguage = {
  id: 'd2',
  load: loadD2,
  // D2 has no strict mode: its SVG can carry external icon hrefs, links and
  // `<foreignObject>` markdown labels. dr-2's sanitiser strips them.
  sanitise: (svg) => sanitiseSvg(svg),
  stylesheet: d2Stylesheet(),
  themedByStylesheet: true,
};
