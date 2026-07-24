// Persistent web-viewer UI state (localStorage), SSR-safe.
//
// One small module that round-trips the web viewer's chrome preferences across
// page loads: the theme mode, the Explorer's expanded folders, each Sidebar
// Section's collapsed/expanded flag, both Sidebars' collapsed flags, and the
// Properties panel's collapsed flag. Everything lives under a single JSON key
// so there is one place to read/write. All access is guarded for SSR (no
// `window`/`localStorage` on the server), and reads tolerate missing/corrupt
// data by returning a partial (the caller fills the rest with its defaults).

import type { ThemeMode } from '$lib/state/theme.svelte';

/** The full persisted UI-state shape. Every field is optional on read. */
export interface WebUiState {
  /** Theme mode: 'system' follows the OS, else an explicit scheme. */
  themeMode: ThemeMode;
  /** bundle-relative paths of expanded Explorer folders. */
  expandedFolders: string[];
  /** Sidebar Section expanded flags. */
  explorerOpen: boolean;
  tagsOpen: boolean;
  outlineOpen: boolean;
  backlinksOpen: boolean;
  /** Whole-Sidebar collapse flags. */
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  /** Sidebar content widths in px (drag-resized; clamped on read by the caller). */
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  /** Properties panel expanded flag. */
  propertiesOpen: boolean;
}

const KEY = 'sunstone:webUI';

/**
 * Load the persisted UI state as a partial (only the keys actually stored).
 * Returns `{}` on the server, a missing key, or corrupt JSON — the caller
 * merges it over its own defaults.
 */
export function loadUiState(): Partial<WebUiState> {
  if (typeof localStorage === 'undefined') return {};
  const raw = localStorage.getItem(KEY);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<WebUiState>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist the full UI state. A no-op on the server. */
export function saveUiState(state: WebUiState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage full / disabled — best-effort, never throw into the UI */
  }
}
