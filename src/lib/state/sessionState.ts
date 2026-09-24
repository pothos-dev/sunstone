// The pure half of the per-Bundle session store (`session.svelte.ts`): the
// mapping between the persisted `BundleState` and the store's fields, so the
// per-field defaults and legacy migrations are unit-testable (CLAUDE.md: pure
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
  editorMode: EditorMode;
  layout: StoredLayout | null;
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
 * - the legacy tri-state `editorMode` ('edit'/'hybrid'/'view') migrates to
 *   'editing'/'read', and an absent one defaults to 'read';
 * - sidebar widths default to the shared default and are clamped, so a
 *   corrupt/out-of-range width cannot wedge the layout;
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
    editorMode: migrateEditorMode(state.editorMode),
    layout: state.layout ?? null,
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
    editorMode: fields.editorMode,
    layout: fields.layout,
    window: fields.window,
  };
}
