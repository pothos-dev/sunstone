/**
 * Shared constants for the `sunstone serve` runner (`playwright.serve.config.ts`).
 *
 * The served Bundle is a throwaway git repo seeded from the same read-only
 * fixture the web e2e suite uses (`seedFixtureRepo`), at its own fixed temp
 * path so the two runners never share state. A git repo, so the spec can prove
 * serve mode reads history the way the desktop does — and that a Save lands NO
 * commit.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The directory `sunstone serve` serves. */
export const SERVE_BUNDLE_DIR = join(tmpdir(), 'sunstone-serve-bundle');

/** The port the runner starts `sunstone serve` on. */
export const SERVE_PORT = Number(process.env.SUNSTONE_TEST_SERVE_PORT ?? 5299);
