// Pure snapshot/restore helpers for WebViewer's persisted UI state
// (localStorage, via `./uiState`). Kept separate from `WebViewer.svelte` so the
// bookkeeping — what fields make up a snapshot, and how a loaded partial state
// is applied back onto the component's `$state` fields — is unit-testable
// without Playwright.
import type { ThemeMode } from '$lib/state/theme.svelte';
import { clampSidebarWidth } from '$lib/sidebarResize';
import type { WebUiState } from './uiState';

/** The live values `WebViewer.svelte` tracks in its own `$state`, mirroring
 *  every field of `WebUiState`. */
export interface WebViewerUiFields {
  themeMode: ThemeMode;
  expandedFolders: Set<string>;
  explorerOpen: boolean;
  tagsOpen: boolean;
  outlineOpen: boolean;
  backlinksOpen: boolean;
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  propertiesOpen: boolean;
}

/** Build the persistable snapshot from the component's current live fields. */
export function snapshotWebViewerUiState(fields: WebViewerUiFields): WebUiState {
  return {
    themeMode: fields.themeMode,
    expandedFolders: [...fields.expandedFolders],
    explorerOpen: fields.explorerOpen,
    tagsOpen: fields.tagsOpen,
    outlineOpen: fields.outlineOpen,
    backlinksOpen: fields.backlinksOpen,
    leftSidebarOpen: fields.leftSidebarOpen,
    rightSidebarOpen: fields.rightSidebarOpen,
    leftSidebarWidth: fields.leftSidebarWidth,
    rightSidebarWidth: fields.rightSidebarWidth,
    propertiesOpen: fields.propertiesOpen,
  };
}

/** A partial set of field updates to apply back onto the component's `$state`,
 *  derived from a loaded (possibly partial/corrupt) `WebUiState`. Sidebar
 *  widths are clamped; `expandedFolders`, when present, is turned into a
 *  fresh `Set`. Only keys actually present in `ui` appear here — the caller
 *  assigns each present key onto its own `$state` variable (Svelte's fine-
 *  grained reactivity needs a per-field assignment, not a merged object). */
export function restoreWebViewerUiState(
  ui: Partial<WebUiState>,
): Partial<WebViewerUiFields> {
  const patch: Partial<WebViewerUiFields> = {};
  if (ui.themeMode) patch.themeMode = ui.themeMode;
  if (typeof ui.explorerOpen === 'boolean') patch.explorerOpen = ui.explorerOpen;
  if (typeof ui.tagsOpen === 'boolean') patch.tagsOpen = ui.tagsOpen;
  if (typeof ui.outlineOpen === 'boolean') patch.outlineOpen = ui.outlineOpen;
  if (typeof ui.backlinksOpen === 'boolean') patch.backlinksOpen = ui.backlinksOpen;
  if (typeof ui.leftSidebarOpen === 'boolean') patch.leftSidebarOpen = ui.leftSidebarOpen;
  if (typeof ui.rightSidebarOpen === 'boolean') patch.rightSidebarOpen = ui.rightSidebarOpen;
  if (typeof ui.leftSidebarWidth === 'number')
    patch.leftSidebarWidth = clampSidebarWidth(ui.leftSidebarWidth);
  if (typeof ui.rightSidebarWidth === 'number')
    patch.rightSidebarWidth = clampSidebarWidth(ui.rightSidebarWidth);
  if (typeof ui.propertiesOpen === 'boolean') patch.propertiesOpen = ui.propertiesOpen;
  if (Array.isArray(ui.expandedFolders)) patch.expandedFolders = new Set(ui.expandedFolders);
  return patch;
}
