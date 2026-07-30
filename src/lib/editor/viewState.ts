import { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { BuildEditorOptions, EditorMode } from './cm';
import type { ResolvedTheme } from './mermaidBlocks';

/**
 * Per-`EditorView` "session state" that used to live as five parallel WeakMaps
 * (`viewOptions`, `viewPath`, `viewWikiCompartment`, `viewLivePreviewCompartment`,
 * `viewMode`, `viewMermaidTheme`) keyed separately by the same `view`. Centralized
 * here as one record behind one WeakMap so callers get/set a single entry instead
 * of touching five maps with repeated `.get(view) ?? default` boilerplate.
 */
interface ViewSession {
  options?: BuildEditorOptions;
  path: string | null;
  wikiCompartment?: Compartment;
  livePreviewCompartment?: Compartment;
  mode?: EditorMode;
  mermaidTheme?: ResolvedTheme;
}

const sessions = new WeakMap<EditorView, ViewSession>();

function session(view: EditorView): ViewSession {
  let s = sessions.get(view);
  if (!s) {
    s = { path: null };
    sessions.set(view, s);
  }
  return s;
}

/** Seed a view's session (called once from `buildEditor`). */
export function initViewSession(
  view: EditorView,
  options: BuildEditorOptions,
  wikiCompartment: Compartment,
  livePreviewCompartment: Compartment,
  mode: EditorMode,
  mermaidTheme: ResolvedTheme,
): void {
  sessions.set(view, {
    options,
    path: options.path ?? null,
    wikiCompartment,
    livePreviewCompartment,
    mode,
    mermaidTheme,
  });
}

export function getViewOptions(view: EditorView): BuildEditorOptions | undefined {
  return sessions.get(view)?.options;
}

export function getViewPath(view: EditorView): string | null {
  return sessions.get(view)?.path ?? null;
}

export function setViewPath(view: EditorView, path: string | null): void {
  session(view).path = path;
}

export function getWikiCompartment(view: EditorView): Compartment | undefined {
  return sessions.get(view)?.wikiCompartment;
}

/** Get the view's wiki Compartment, creating (and storing) one if it has none yet. */
export function ensureWikiCompartment(view: EditorView): Compartment {
  const s = session(view);
  if (!s.wikiCompartment) s.wikiCompartment = new Compartment();
  return s.wikiCompartment;
}

export function getLivePreviewCompartment(view: EditorView): Compartment | undefined {
  return sessions.get(view)?.livePreviewCompartment;
}

/** Get the view's live-preview Compartment, creating (and storing) one if it has none yet. */
export function ensureLivePreviewCompartment(view: EditorView): Compartment {
  const s = session(view);
  if (!s.livePreviewCompartment) s.livePreviewCompartment = new Compartment();
  return s.livePreviewCompartment;
}

export function getViewMode(view: EditorView): EditorMode | undefined {
  return sessions.get(view)?.mode;
}

export function setViewMode(view: EditorView, mode: EditorMode): void {
  session(view).mode = mode;
}

export function getViewMermaidTheme(view: EditorView): ResolvedTheme | undefined {
  return sessions.get(view)?.mermaidTheme;
}

export function setViewMermaidTheme(view: EditorView, theme: ResolvedTheme): void {
  session(view).mermaidTheme = theme;
}
