import { describe, expect, test } from "bun:test";
import {
  clampZoom,
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  wheelZoomStep,
  zoomIn,
  zoomOut,
} from "./zoom";

describe("zoom", () => {
  test("clamps into range and rejects non-finite values", () => {
    expect(clampZoom(1.25)).toBe(1.25);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
  });

  test("steps up and down through the stops, saturating at the ends", () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomOut(1)).toBe(0.9);
    expect(zoomIn(MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(zoomOut(MIN_ZOOM)).toBe(MIN_ZOOM);
    // An off-stop value (e.g. from an older persisted setting) snaps to the
    // neighbouring stop rather than getting stuck.
    expect(zoomIn(1.05)).toBe(1.1);
    expect(zoomOut(1.05)).toBe(1);
  });

  test("wheel zoom only fires with the primary modifier held", () => {
    expect(wheelZoomStep({ ctrlKey: true, metaKey: false, deltaY: -120 })).toBe(
      1,
    );
    expect(wheelZoomStep({ ctrlKey: false, metaKey: true, deltaY: 120 })).toBe(
      -1,
    );
    expect(
      wheelZoomStep({ ctrlKey: false, metaKey: false, deltaY: -120 }),
    ).toBe(0);
    expect(wheelZoomStep({ ctrlKey: true, metaKey: false, deltaY: 0 })).toBe(0);
  });
});
