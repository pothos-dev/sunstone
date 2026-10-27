// The D2 Web Worker (dr-3, ADR-0014). Spawned by `d2Language.ts` the first
// time a ` ```d2 ` fence renders; never part of either shell's initial bundle.
//
// `@terrastruct/d2`'s browser build carries `d2.wasm` inline (brotli, base64)
// and decodes it on the thread that constructs `D2` — about 0.7 s of
// JavaScript — before handing it to a worker of its own for the Go runtime and
// elk.js. Constructing `D2` here keeps that decode, and the 8 MB parse, off the
// main thread too, so a cold first render never stalls typing.
//
// The library picks its browser code path with `typeof window`, which is
// undefined in a worker; aliasing `window` to the worker scope makes it spawn
// its inner worker with the browser `Worker` API (nested dedicated workers,
// supported by Chromium and WebKitGTK).
//
// Protocol: one `{ type: 'ready' }` or `{ type: 'failed', message }` after
// start-up, then one `{ id, svg }` or `{ id, error }` per `{ id, source, salt }`.

import { D2 } from '@terrastruct/d2';
import { compileAndRender, type D2Like } from './d2Engine';
import { serialQueue } from './serialQueue';

/** A render request from the main thread. */
export interface D2WorkerRequest {
  readonly id: number;
  readonly source: string;
  readonly salt: string;
}

/** A message back to the main thread. */
export type D2WorkerResponse =
  | { readonly type: 'ready' }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly id: number; readonly svg: string }
  | { readonly id: number; readonly error: string };

const scope = self as unknown as {
  window?: unknown;
  postMessage(message: D2WorkerResponse): void;
  onmessage: ((event: MessageEvent<D2WorkerRequest>) => void) | null;
};
scope.window ??= scope;

const d2 = new D2() as unknown as D2Like & { ready: Promise<void> };
const enqueue = serialQueue();

scope.onmessage = ({ data: { id, source, salt } }) => {
  void enqueue(() => compileAndRender(d2, source, salt)).then(
    (svg) => scope.postMessage({ id, svg }),
    (err: unknown) =>
      scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
  );
};

d2.ready.then(
  () => scope.postMessage({ type: 'ready' }),
  (err: unknown) =>
    scope.postMessage({ type: 'failed', message: err instanceof Error ? err.message : String(err) }),
);
