import type { TreeNode } from '$lib/types';
import type { RenderPayload } from './render';
import { ensureWasm } from '$lib/wasm';

/** Every FILE path (bundle-relative) in the tree — the URL-resolution set. */
function filePaths(tree: TreeNode, into: string[] = []): string[] {
  if (!tree.isDir) into.push(tree.path);
  for (const c of tree.children ?? []) filePaths(c, into);
  return into;
}

/**
 * Resolve a decoded pretty URL path to a Concept path against `paths` (a folder
 * index wins over a same-named leaf). Mirrors the wasm `BundleIndex.urlToConcept`
 * for the SSR path, where wasm is browser-only (ADR 0006 §1/§5) yet this
 * universal `load` still runs on the server — the ONLY place this rule is
 * duplicated, and only when the handle is unavailable.
 */
function resolveUrlPathInline(urlPath: string, paths: string[]): string | null {
  const set = new Set(paths);
  const segs = urlPath.split('/').filter(Boolean);
  if (segs.length === 0) return set.has('index.md') ? 'index.md' : null;
  const p = segs.join('/');
  for (const candidate of [`${p}/index.md`, `${p}.md`]) {
    if (set.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a decoded pretty URL path to a Concept path. On the client this goes
 * through the wasm `BundleIndex.urlToConcept` handle (single source, retiring
 * `collectFilePaths`); on SSR (wasm browser-only) it falls back to the inline
 * mirror over the same file set.
 */
async function resolveUrlPath(urlPath: string, tree: TreeNode): Promise<string | null> {
  const paths = filePaths(tree);
  const wasm = await ensureWasm();
  if (!wasm) return resolveUrlPathInline(urlPath, paths);
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
 * Load the Bundle root + Explorer tree and, for the Concept addressed by
 * `urlPath` (a pretty, already-decoded path like `research/providers/mistral-ai`
 * or `''` for the root), the server-rendered payload — so first paint shows the
 * RENDERED Concept without waiting on hydration.
 *
 * `fetch` is relative (`/api/...`), routed through the SvelteKit server (SSR) or
 * the browser origin (client nav), both proxied to `sunstone-server` (see
 * `src/hooks.server.ts`). The pretty path is resolved to a real Concept path
 * against the tree's file set (`urlToConcept`); an unknown path renders empty.
 */
export async function loadConcept(fetchFn: typeof fetch, urlPath: string): Promise<WebPageData> {
  const [bundleRoot, tree, user] = await Promise.all([
    fetchFn('/api/bundle-root').then((r) => r.json() as Promise<string>),
    fetchFn('/api/tree').then((r) => r.json() as Promise<TreeNode>),
    loadUser(fetchFn),
  ]);

  const selected = await resolveUrlPath(urlPath, tree);
  let rendered: RenderPayload | null = null;
  let renderError: string | null = null;
  if (selected) {
    const res = await fetchFn(`/api/render?path=${encodeURIComponent(selected)}`);
    if (res.ok) {
      rendered = (await res.json()) as RenderPayload;
    } else {
      // Broken/missing target: keep the shell, surface the error read-only.
      renderError = `${res.status}: ${(await res.text().catch(() => '')) || 'not found'}`;
    }
  }

  return { web: true, bundleRoot, tree, selected, rendered, renderError, user };
}
