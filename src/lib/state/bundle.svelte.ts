import { backend } from '$lib/ipc';
import { errMessage } from '$lib/errors';
import { setNodeLifecycle, setNodeTitle } from '$lib/treeNav';
import type { TreeNode } from '$lib/types';

/**
 * Bundle state: the opened Bundle's directory tree.
 * Rune-backed (Svelte 5); loaded via the Backend seam.
 */
class BundleStore {
  /** Recursive directory tree; null until loaded. */
  tree = $state<TreeNode | null>(null);
  /** True while the initial load is in flight. */
  loading = $state<boolean>(false);
  /** Last load error, if any. */
  error = $state<string | null>(null);

  /** Load the Bundle tree from the backend. */
  async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      this.tree = await backend.listTree();
    } catch (e) {
      this.error = errMessage(e);
    } finally {
      this.loading = false;
    }
  }

  /** Update one Concept's Explorer title after a save (no Bundle re-walk). */
  retitle(path: string, title: string | null): void {
    if (this.tree) setNodeTitle(this.tree, path, title);
  }

  /** Update one Concept's Explorer lifecycle keys after a save (no Bundle re-walk). */
  relifecycle(path: string, status: string | null, staleAfter: string | null): void {
    if (this.tree) setNodeLifecycle(this.tree, path, status, staleAfter);
  }
}

export const bundle = new BundleStore();
