// Typographic dashes (smart-dashes): render `--` as an en-dash (–) and `---`
// as an em-dash (—) in the live preview, without touching the underlying
// markdown (the decoration is visual-only, like every other preview render).
//
// Split Obsidian-style: `findSmartDashes` is the pure, unit-testable scanner
// over plain strings (project convention); `smartDashes` is the thin CodeMirror
// decoration layer following the `citations.ts` pattern (reading mode always
// renders; editing mode reveals the raw hyphens under the cursor).

/** A hyphen run to render as a typographic dash. */
export interface DashRun {
  from: number;
  to: number;
  /** The dash to display: en-dash for `--`, em-dash for `---`. */
  dash: '–' | '—';
}

/** True for lines that are pure markdown structure built FROM dashes —
 * thematic breaks (`---`), setext underlines (`----`), table delimiter rows
 * (`| --- | :--- |`) and frontmatter fences — where a typographic dash would
 * corrupt the reading of the syntax. */
function isDashStructureLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  return /^[-\s|:]+$/.test(t) && t.includes('-');
}

/** Replace inline-code spans (`` `…` ``) with spaces so the dash scan cannot
 * match inside them; lengths/offsets are preserved. */
function blankInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

/**
 * Find every `--` / `---` run in a markdown BODY that should render as a
 * typographic dash. Skipped:
 *  - fenced code blocks (``` / ~~~) and inline code spans;
 *  - dash-structure lines (thematic breaks, setext underlines, table
 *    delimiter rows);
 *  - HTML comment delimiters (`<!--`, `-->`);
 *  - runs of 4+ hyphens (likely deliberate ASCII art / separators).
 */
export function findSmartDashes(text: string): DashRun[] {
  const runs: DashRun[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let fence: string | null = null; // the opening fence marker, ``` or ~~~
  for (const line of lines) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1] === fence) fence = null;
    } else if (fenceMatch) {
      fence = fenceMatch[1];
    } else if (!isDashStructureLine(line)) {
      const scan = blankInlineCode(line);
      const re = /-{2,}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(scan)) !== null) {
        if (m[0].length > 3) continue;
        const before = scan[m.index - 1];
        const after = scan[m.index + m[0].length];
        // `<!--` / `-->` — leave HTML comment delimiters alone.
        if (before === '!' || after === '>') continue;
        runs.push({
          from: offset + m.index,
          to: offset + m.index + m[0].length,
          dash: m[0].length === 2 ? '–' : '—',
        });
      }
    }
    offset += line.length + 1;
  }
  return runs;
}
