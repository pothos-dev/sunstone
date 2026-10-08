// The fake's half of "Create Bundle" (ov-8). The fake serves one fixture
// whatever folder is "open", so creating a Bundle declares the fixture's root
// `index.md` OKF. The writer itself is the shared Rust one, through wasm; no
// TS twin (ADR 0006).

import { declareOkfVersion } from '$lib/wasm/exports';
import { FILES } from './store';

/**
 * Make the store's root `index.md` declare `okf_version` (created when absent,
 * the key added when missing, an existing declaration left alone). Only the
 * root `index.md` is written. Returns whether it was. Needs wasm ready.
 */
export function declareRootIndex(title: string): boolean {
  const next = declareOkfVersion(FILES['index.md'] ?? null, title);
  if (next === null) return false;
  FILES['index.md'] = next;
  return true;
}
