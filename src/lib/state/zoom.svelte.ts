/**
 * UI zoom store (Ctrl/Cmd +/-/0 and Ctrl/Cmd+wheel).
 *
 * Holds ONE multiplier and applies it to `<html>`: the root font-size
 * (`app.css`'s `--font-ui-size`) so every `rem`-based chrome dimension scales,
 * plus the two content sizes (from `--font-content-size`) that must NOT track the root
 * (`--atomic-editor-body-size` for the CodeMirror body, `--rendered-body-size`
 * for the server-rendered article). Scaling those alongside the root keeps the
 * editor and the web viewer in step with the chrome.
 *
 * Persisted in `localStorage` (not Bundle state): zoom is a per-display
 * preference, not per-Bundle, and it must be readable synchronously before the
 * async Bundle restore lands so the app never paints at the wrong size.
 */

import { clampZoom, DEFAULT_ZOOM, zoomIn, zoomOut } from "$lib/zoom";

const KEY = "sunstone:zoom";

function readStored(): number {
  if (typeof localStorage === "undefined") return DEFAULT_ZOOM;
  const raw = localStorage.getItem(KEY);
  if (raw === null) return DEFAULT_ZOOM;
  return clampZoom(Number.parseFloat(raw));
}

class ZoomStore {
  /** The current multiplier; `1` is 100%. */
  scale = $state<number>(DEFAULT_ZOOM);

  /** Seed from `localStorage`. Safe on SSR (falls back to 100%). */
  load(): void {
    this.scale = readStored();
  }

  in(): void {
    this.set(zoomIn(this.scale));
  }

  out(): void {
    this.set(zoomOut(this.scale));
  }

  reset(): void {
    this.set(DEFAULT_ZOOM);
  }

  set(scale: number): void {
    const next = clampZoom(scale);
    if (next === this.scale) return;
    this.scale = next;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(KEY, String(next));
      } catch {
        // Storage full/blocked: zoom still applies for this session.
      }
    }
  }
}

export const zoom = new ZoomStore();

/**
 * Apply `scale` to the document root. Called from an `$effect` reading
 * `zoom.scale`, so the store stays a pure state holder (same split as
 * `applyTheme`).
 */
export function applyZoom(scale: number): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Scale the base sizes `app.css` declares (`--font-ui-size`,
  // `--font-content-size`, which the user's config may override) rather than
  // literals, so zoom multiplies whatever the configured 100% is.
  root.style.fontSize = `calc(var(--font-ui-size) * ${scale})`;
  const body = `calc(var(--font-content-size) * ${scale})`;
  root.style.setProperty("--atomic-editor-body-size", body);
  root.style.setProperty("--rendered-body-size", body);
}
