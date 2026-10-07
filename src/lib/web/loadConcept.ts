import { error } from '@sveltejs/kit';
import type { RenderPayload, TreeNode } from '$lib/types';
import { ensureWasm } from '$lib/wasm';
import { urlToConceptInline } from './conceptUrl';

/** Every FILE path (bundle-relative) in the tree — the URL-resolution set. */
function filePaths(tree: TreeNode, into: string[] = []): string[] {
  if (!tree.isDir) into.push(tree.path);
  for (const c of tree.children ?? []) filePaths(c, into);
  return into;
}

/**
 * Resolve a decoded pretty URL path to a Concept path. On the client this goes
 * through the wasm `BundleIndex.urlToConcept` handle (single source, retiring
 * `collectFilePaths`); on SSR (wasm browser-only) it falls back to the inline
 * mirror `urlToConceptInline` over the same file set.
 */
async function resolveUrlPath(urlPath: string, tree: TreeNode): Promise<string | null> {
  const paths = filePaths(tree);
  const wasm = await ensureWasm();
  if (!wasm) return urlToConceptInline(urlPath, paths);
  const index = new wasm.BundleIndex(paths);
  try {
    return index.urlToConcept(urlPath) ?? null;
  } finally {
    index.free();
  }
}

/** SSR'd data the web `+page` routes hand to the viewer. */
export interface WebPageData {
  web: true;
  bundleRoot: string;
  tree: TreeNode;
  selected: string | null;
  rendered: RenderPayload | null;
  renderError: string | null;
  /**
   * The authenticated user (Auth.js session), or `null` when signed out. Read
   * from the Auth.js `/auth/session` endpoint through the same relative `fetch`
   * (SSR or client), so the viewer can show the Edit affordance ONLY to a
   * signed-in user (ticket 06). The display `name` plus an optional avatar
   * `image` URL (present only when the OIDC provider returns a `picture`).
   */
  user: WebUser | null;
}

/** The signed-in identity the viewer surfaces (name + optional avatar image). */
export interface WebUser {
  name: string;
  image?: string | null;
}

/** The subset of the Auth.js session JSON the viewer needs. */
interface SessionResponse {
  user?: { name?: string | null; image?: string | null } | null;
}

/** Fetch the current user from Auth.js, or `null` when signed out / on error. */
async function loadUser(fetchFn: typeof fetch): Promise<WebUser | null> {
  try {
    const res = await fetchFn('/auth/session');
    if (!res.ok) return null;
    const session = (await res.json()) as SessionResponse | null;
    const name = session?.user?.name;
    return name ? { name, image: session?.user?.image ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * Fetch one of the JSON payloads the shell cannot render without (Bundle root,
 * tree). A failed upstream — `sunstone-server` down or erroring — becomes a 502
 * SvelteKit error naming the endpoint and the upstream `status: body` (the same
 * shape as `renderError`), rather than an opaque JSON-parse 500.
 */
async function fetchShellJson<T>(fetchFn: typeof fetch, path: string): Promise<T> {
  const res = await fetchFn(path);
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')) || 'no response body';
    error(502, `Cannot load ${path}: ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

/**
 * Load the Bundle root + Explorer tree and, for the Concept addressed by
 * `urlPath` (a pretty, already-decoded path like `research/providers/mistral-ai`
 * or `''` for the root), the server-rendered payload — so first paint shows the
 * RENDERED Concept without waiting on hydration.
 *
 * `fetch` is relative (`/_api/...`), routed through the SvelteKit server (SSR) or
 * the browser origin (client nav), both proxied to `sunstone-server` (see
 * `src/hooks.server.ts`). The pretty path is resolved to a real Concept path
 * against the tree's file set (`urlToConcept`); an unknown path keeps the shell
 * and reports `renderError` (the URL stays put — no fallback to the root).
 */
export async function loadConcept(fetchFn: typeof fetch, urlPath: string): Promise<WebPageData> {
  const [bundleRoot, tree, user] = await Promise.all([
    fetchShellJson<string>(fetchFn, '/_api/bundle-root'),
    fetchShellJson<TreeNode>(fetchFn, '/_api/tree'),
    loadUser(fetchFn),
  ]);

  const selected = await resolveUrlPath(urlPath, tree);
  let rendered: RenderPayload | null = null;
  let renderError: string | null = null;
  if (selected) {
    const res = await fetchFn(`/_api/render?path=${encodeURIComponent(selected)}`);
    if (res.ok) {
      rendered = (await res.json()) as RenderPayload;
    } else {
      // Broken/missing target: keep the shell, surface the error read-only.
      const detail = (await res.text().catch(() => '')) || 'not found';
      renderError = `Cannot render ${selected}: ${res.status}: ${detail}`;
    }
  } else if (urlPath !== '') {
    renderError = `Concept not found: /${urlPath}`;
  }

  return { web: true, bundleRoot, tree, selected, rendered, renderError, user };
}
