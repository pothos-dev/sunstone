// Per-Tile review-mode state machine (working-tree ↔ HEAD diff + history
// stepper), extracted from Tile.svelte. Owns the review flag, the loaded
// `FileHistory`, the stepper position, and the read-only CriticMarkup review
// view — everything keyed off the Tile's `activePath`/`content` alone.
//
// This is reactive orchestration over runes + CodeMirror, so it carries no unit
// tests of its own; the pure decisions live in `$lib/editor/review`
// (availability) and `$lib/editor/reviewStepper` (step maths), each unit-tested,
// and the Playwright specs `review-toggle.spec.ts` / `review-stepper.spec.ts`
// cover the behaviour end to end.
//
// `createTileReview` MUST be called during component initialisation (it sets up
// `$effect`s). The Tile binds the review host element to `parent` and renders
// off `active` / `avail` / `stepInfo`.

import type { EditorView } from '@codemirror/view';
import { backend } from '$lib/ipc';
import type { FileHistory } from '$lib/types';
import { buildReviewEditor, setReviewText } from '$lib/editor/cm';
import { diffToCriticMarkup } from '$lib/diff/diffToCriticMarkup';
import { reviewAvailability } from '$lib/editor/review';
import { reviewStep, maxStep } from '$lib/editor/reviewStepper';

export interface TileReviewDeps {
  /** The Tile's open Concept path (bundle-relative), or null when empty. */
  getPath: () => string | null;
  /** The Tile's live buffer content (the working-tree side of position 0). */
  getContent: () => string;
  /** The resolved theme name, stamped on the review view's DOM on build. */
  getTheme: () => string;
  /** Re-focus the Tile's main editor view after leaving review. */
  focusEditor: () => void;
}

export class TileReview {
  /** Whether review mode is showing (the review view replaces the editor). */
  active = $state(false);
  /** Host element for the read-only review view (bound from the template). */
  parent = $state<HTMLDivElement | null>(null);
  /** The rendered CriticMarkup diff text, or null when review is off. */
  text = $state<string | null>(null);
  /** Git history of the open Concept (null while loading / nothing open). */
  history = $state<FileHistory | null>(null);
  /** Stepper position: 0 = working tree ↔ commits[0], 1 = commits[0] ↔ [1], … */
  position = $state(0);

  /** Whether the Review toggle is enabled, with its explanatory tooltip. */
  avail = $derived(reviewAvailability(this.history));
  commits = $derived(this.history?.status === 'ok' ? this.history.commits : []);
  /** The current step's comparison label / commit metadata / nav flags. */
  stepInfo = $derived(reviewStep(this.commits, this.position));

  #view: EditorView | null = null;
  #deps: TileReviewDeps;

  constructor(deps: TileReviewDeps) {
    this.#deps = deps;

    // Load the git history for the open Concept; switching Concepts exits review.
    $effect(() => {
      const path = deps.getPath();
      this.active = false;
      this.text = null;
      this.history = null;
      this.position = 0;
      if (path === null) return;
      let cancelled = false;
      void backend.fileHistory(path).then((h) => {
        if (!cancelled) this.history = h;
      });
      return () => {
        cancelled = true;
      };
    });

    // Build / tear down the read-only review view as `active` flips.
    $effect(() => {
      if (this.active && this.parent && this.text !== null && !this.#view) {
        this.#view = buildReviewEditor(this.parent, this.text);
        this.#view.dom.setAttribute('data-theme', deps.getTheme());
        this.#view.focus();
      } else if (!this.active && this.#view) {
        this.#view.destroy();
        this.#view = null;
      }
    });
  }

  async #renderStep(pos: number): Promise<boolean> {
    const path = this.#deps.getPath();
    if (path === null) return false;
    const step = reviewStep(this.commits, pos);
    const oldSide = await backend.fileAtRev(path, step.oldRev);
    if (oldSide.status !== 'ok') return false;
    let newContent: string;
    if (step.newRev === null) {
      newContent = this.#deps.getContent();
    } else {
      const newSide = await backend.fileAtRev(path, step.newRev);
      if (newSide.status !== 'ok') return false;
      newContent = newSide.content;
    }
    if (this.#deps.getPath() !== path) return false;
    this.text = diffToCriticMarkup(oldSide.content, newContent);
    if (this.#view) setReviewText(this.#view, this.text);
    return true;
  }

  async enter(): Promise<void> {
    const path = this.#deps.getPath();
    if (path === null || this.active || !this.avail.enabled) return;
    this.position = 0;
    if (!(await this.#renderStep(0))) return;
    if (this.#deps.getPath() !== path) return;
    this.active = true;
  }

  step = (delta: number): void => {
    if (!this.active) return;
    const next = this.position + delta;
    if (next < 0 || next > maxStep(this.commits)) return;
    this.position = next;
    void this.#renderStep(next);
  };

  exit = (): void => {
    if (!this.active) return;
    this.active = false;
    this.text = null;
    queueMicrotask(() => this.#deps.focusEditor());
  };

  toggle = (): void => {
    if (this.active) this.exit();
    else void this.enter();
  };

  /** Mirror a theme change onto the live review view (Tile's theme effect). */
  syncTheme(resolved: string): void {
    if (this.#view) this.#view.dom.setAttribute('data-theme', resolved);
  }

  /** Tear down the review view unconditionally (Tile onDestroy). */
  destroy(): void {
    this.#view?.destroy();
    this.#view = null;
  }
}

/** Create the review state machine for one Tile (call during component init). */
export function createTileReview(deps: TileReviewDeps): TileReview {
  return new TileReview(deps);
}
