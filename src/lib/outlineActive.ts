// Which Outline entry is the "current" heading for a given scroll position
// (slice: outline-active-heading).
//
// The editor reports the full-document line sitting at a small probe offset
// below the viewport top — the same spot an Outline click scrolls a heading to.
// The active heading is then the LAST heading at or above that line: while you
// read a section, that section's heading stays highlighted, and the highlight
// moves the moment the next heading crosses the probe.
//
// The end of a Concept is a special case: the document runs out of scroll, so a
// heading in the last screenful can never reach the probe and would never light
// up — not even when its own Outline entry is clicked. Rather than pad the
// document (CodeMirror's `scrollPastEnd()`, and an equivalent hand-rolled
// spacer, both break the mermaid extension's render loop), the editor reports
// the line at the viewport BOTTOM once it is scrolled to the end. The rule stays
// "the last heading at or above the reported line", so the final heading in view
// wins — which is what "you are at the end of the Concept" should look like.
//
// Pure so it can be unit-tested; the DOM/CodeMirror side lives in `cm.ts`
// (`lineAtViewportTop`) and `Tile.svelte`.

/**
 * Distance below the editor viewport's top edge at which the "current" line is
 * probed, in CSS pixels. Matches the resting position of a heading scrolled to
 * by an Outline click (`y: 'start'`), so clicking an entry highlights it.
 */
export const ACTIVE_HEADING_PROBE_PX = 50;

/**
 * Index into `headingLines` (ascending, 1-based full-document lines) of the last
 * heading at or above `probeLine`, or -1 when the probe sits above every heading
 * (e.g. scrolled to the very top of a Concept that opens with prose).
 */
export function activeHeadingIndex(headingLines: readonly number[], probeLine: number): number {
  let active = -1;
  for (let i = 0; i < headingLines.length; i++) {
    if (headingLines[i] > probeLine) break;
    active = i;
  }
  return active;
}
