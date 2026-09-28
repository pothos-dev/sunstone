/**
 * The two line spaces a Tile translates between.
 *
 * - **File line**: 1-based over the whole Concept file, frontmatter included.
 *   Search hits, Outline entries and heading lookups speak it.
 * - **Body line**: 1-based over the CodeMirror doc, which holds only the body
 *   (the frontmatter renders in its own panel, ADR 0003). The body starts on the
 *   line right after the closing fence, so the offset is exactly the number of
 *   lines the frontmatter block occupies (`frontmatterLineCount`).
 */

/**
 * The body line for file line `line`, given `fmLines` frontmatter lines. A line
 * inside the frontmatter block clamps to body line 1 (the top of the editor).
 */
export function fileLineToBody(line: number, fmLines: number): number {
  return Math.max(1, line - fmLines);
}

/** The file line for body line `line`, given `fmLines` frontmatter lines. */
export function bodyLineToFile(line: number, fmLines: number): number {
  return line + fmLines;
}
