// The pure half of the per-Bundle session store (`session.svelte.ts`): the
// mapping between the persisted `BundleState` and the store's fields, so the
// per-field defaults and legacy migrations are unit-testable (AGENTS.md: pure
// logic lives in plain `.ts`; the rune module stays thin over it).

import type { EditorMode } from '$lib/editor/cm';
import { migrateEditorMode, type StoredLayout } from '$lib/state/layoutPersist';
import type { BundleState } from '$lib/types';
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH } from '$lib/sidebarResize';
import { BUILTIN_PANEL_DEFAULTS, type PanelDefaults } from '$lib/settings/panelDefaults';

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
 * - which Sidebars and Sections are expanded, whether frontmatter and titles
 *   show, and the editor mode come from `defaults` (the settings page's
 *   `PanelDefaults`; built-in: left Sidebar, Explorer, Outline and Backlinks
 *   EXPANDED, Tags and the right Sidebar COLLAPSED, titles on, frontmatter
 *   hidden, Read mode) — a field the Bundle's state has always wins;
 * - `frontmatterShown` defaults hidden, falling back to its pre-ADR-0008 name
 *   `propertiesShown` so an existing user's choice survives the rename;
 * - `titlesShown` (label by frontmatter `title`) defaults on;
 * - the legacy tri-state `editorMode` ('edit'/'hybrid'/'view') migrates to
 *   'editing'/'read', and an absent one takes `defaults.editorMode`;
 * - sidebar widths default to the shared default and are clamped, so a
 *   corrupt/out-of-range width cannot wedge the layout;
 * - `bundleRootOverride` defaults to `null` (automatic detection); `''` is a
 *   real choice (the opened folder), not an absence;
 * - `layout` is carried raw (`null` when absent) — validation happens at
 *   restore, in `resolveStoredLayout`.
 */
export function sessionFromBundleState(
  state: BundleState,
  defaults: PanelDefaults = BUILTIN_PANEL_DEFAULTS,
): SessionFields {
  return {
    lastOpenConcept: state.lastOpenConcept ?? null,
    expandedFolders: new Set(state.expandedFolders ?? []),
    recentFiles: state.recentFiles ?? [],
    leftSidebarOpen: state.leftSidebarOpen ?? defaults.leftSidebar,
    explorerOpen: state.explorerOpen ?? defaults.explorer,
    tagsOpen: state.tagsOpen ?? defaults.tags,
    backlinksOpen: state.backlinksOpen ?? defaults.backlinks,
    outlineOpen: state.outlineOpen ?? defaults.outline,
    rightSidebarOpen: state.rightSidebarOpen ?? defaults.rightSidebar,
    leftSidebarWidth: clampSidebarWidth(state.leftSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH),
    rightSidebarWidth: clampSidebarWidth(state.rightSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH),
    frontmatterShown: state.frontmatterShown ?? state.propertiesShown ?? defaults.frontmatter,
    titlesShown: state.titlesShown ?? defaults.titles,
    editorMode: state.editorMode === undefined ? defaults.editorMode : migrateEditorMode(state.editorMode),
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
