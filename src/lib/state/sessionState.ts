// The pure half of the per-Bundle session store (`session.svelte.ts`): the
// mapping between the persisted `BundleState` and the store's fields, so the
// per-field defaults and legacy migrations are unit-testable (AGENTS.md: pure
// logic lives in plain `.ts`; the rune module stays thin over it).

import type { EditorMode } from '$lib/editor/cm';
import { migrateEditorMode, type StoredLayout } from '$lib/state/layoutPersist';
import type { BundleState } from '$lib/types';
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH } from '$lib/sidebarResize';

/** The persisted fields of the session store, in their in-memory shapes. */
export interface SessionFields {
  lastOpenConcept: string | null;
  expandedFolders: Set<string>;
  recentFiles: string[];
  leftSidebarOpen: boolean;
  explorerOpen: boolean;
  tagsOpen: boolean;
  backlinksOpen: boolean;
  outlineOpen: boolean;
  rightSidebarOpen: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  frontmatterShown: boolean;
  titlesShown: boolean;
  editorMode: EditorMode;
  layout: StoredLayout | null;
  /**
   * The user's explicit Bundle root (ov-7): a bundle-relative directory (`''`
   * = the opened folder), or `null` for automatic detection.
   */
  bundleRootOverride: string | null;
  /** Opaque window geometry owned by Rust; carried through untouched. */
  window: unknown;
}

/**
 * Read a loaded `BundleState` into session fields, defaulting every absent
 * field and migrating legacy values:
 *
 * - the left Sidebar and its Sections, and the Outline, default EXPANDED;
 *   Tags and the right Sidebar default COLLAPSED;
 * - `frontmatterShown` defaults hidden, falling back to its pre-ADR-0008 name
 *   `propertiesShown` so an existing user's choice survives the rename;
 * - `titlesShown` (label by frontmatter `title`) defaults on;
 * - the legacy tri-state `editorMode` ('edit'/'hybrid'/'view') migrates to
 *   'editing'/'read', and an absent one defaults to 'read';
 * - sidebar widths default to the shared default and are clamped, so a
 *   corrupt/out-of-range width cannot wedge the layout;
 * - `bundleRootOverride` defaults to `null` (automatic detection); `''` is a
 *   real choice (the opened folder), not an absence;
 * - `layout` is carried raw (`null` when absent) — validation happens at
 *   restore, in `resolveStoredLayout`.
 */
export function sessionFromBundleState(state: BundleState): SessionFields {
  return {
    lastOpenConcept: state.lastOpenConcept ?? null,
    expandedFolders: new Set(state.expandedFolders ?? []),
    recentFiles: state.recentFiles ?? [],
    leftSidebarOpen: state.leftSidebarOpen ?? true,
    explorerOpen: state.explorerOpen ?? true,
    tagsOpen: state.tagsOpen ?? false,
    backlinksOpen: state.backlinksOpen ?? true,
    outlineOpen: state.outlineOpen ?? true,
    rightSidebarOpen: state.rightSidebarOpen ?? false,
    leftSidebarWidth: clampSidebarWidth(state.leftSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH),
    rightSidebarWidth: clampSidebarWidth(state.rightSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH),
    frontmatterShown: state.frontmatterShown ?? state.propertiesShown ?? false,
    titlesShown: state.titlesShown ?? true,
    editorMode: migrateEditorMode(state.editorMode),
    layout: state.layout ?? null,
    bundleRootOverride: state.bundleRootOverride ?? null,
    window: state.window,
  };
}

/**
 * The session fields as a plain `BundleState` for persistence. The collections
 * are copied, `window` is passed through as-is (even when `undefined`), and the
 * legacy `propertiesShown` is never written.
 */
export function bundleStateFromSession(fields: SessionFields): BundleState {
  return {
    lastOpenConcept: fields.lastOpenConcept,
    expandedFolders: [...fields.expandedFolders],
    recentFiles: [...fields.recentFiles],
    leftSidebarOpen: fields.leftSidebarOpen,
    explorerOpen: fields.explorerOpen,
    tagsOpen: fields.tagsOpen,
    backlinksOpen: fields.backlinksOpen,
    rightSidebarOpen: fields.rightSidebarOpen,
    leftSidebarWidth: fields.leftSidebarWidth,
    rightSidebarWidth: fields.rightSidebarWidth,
    outlineOpen: fields.outlineOpen,
    frontmatterShown: fields.frontmatterShown,
    titlesShown: fields.titlesShown,
    editorMode: fields.editorMode,
    layout: fields.layout,
    bundleRootOverride: fields.bundleRootOverride,
    window: fields.window,
  };
}
