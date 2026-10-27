// PlantUML render, engine-agnostic — PURE, no DOM (dr-4, ADR-0016).
//
// Runs against `@plantuml/core`'s `renderToString` in the browser
// (`plantumlLanguage.ts`) and under `bun test` against a stub. Owns how a fence
// body becomes the engine's input lines (the `@startuml` wrap and the palette
// preamble) and how the engine's answer becomes an SVG or a readable error.
//
// The engine reports a bad source not through its error callback but as an
// SVG: a picture of the PlantUML version banner, the source up to the bad
// line, and the message. `plantumlDiagramError` recognises those pictures and
// turns them back into text for the seam's error panel.

/** The slice of `@plantuml/core` we use. */
export interface PlantUmlLike {
  renderToString(
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (message: string) => void,
  ): void;
}

/** The engine input for one fence, and how to map its line numbers back. */
export interface PlantUmlInput {
  readonly lines: string[];
  /** An engine line number (1-based) as a line of the fence body. */
  readonly fenceLine: (engineLine: number) => number;
}

const START = /^\s*@start[a-z]+\b/i;

/**
 * The engine input for a fence `source`, with `preamble` (the palette style)
 * inserted right after its `@start…` line so anything the author writes
 * afterwards overrides it. A fence without an `@start…` line is a bare UML body,
 * as GitHub and GitLab render it, and is wrapped in `@startuml`/`@enduml`.
 */
export function plantumlInput(source: string, preamble: readonly string[]): PlantUmlInput {
  const body = source.split(/\r\n|\r|\n/);
  const start = body.findIndex((line) => START.test(line));
  if (start === -1) {
    const shift = 1 + preamble.length;
    return {
      lines: ['@startuml', ...preamble, ...body, '@enduml'],
      fenceLine: (n) => Math.max(1, n - shift),
    };
  }
  return {
    lines: [...body.slice(0, start + 1), ...preamble, ...body.slice(start + 1)],
    fenceLine: (n) => (n <= start + 1 ? n : Math.max(start + 1, n - preamble.length)),
  };
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** The text lines of an SVG, in document order, entities decoded. */
export function svgTextLines(svg: string): string[] {
  return Array.from(svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g), (m) => decodeEntities(m[1]));
}

const FROM_LINE = /^\[From .*\(line (\d+)\) \]$/;
const NOT_SUPPORTED = 'Diagram not supported by this release of PlantUML';

/**
 * The error message an engine SVG stands for, or `null` for a real diagram.
 *
 *  - a syntax or include error: the version banner, `[From … (line N) ]`, the
 *    source up to line N, then the message on the last line. Reported as
 *    `line N: message`, N mapped back to the fence by `fenceLine`.
 *  - an unknown `@start…` directive: "Diagram not supported…" and the
 *    directive.
 *  - an engine crash: "An error has occurred…" and what follows.
 */
export function plantumlDiagramError(
  svg: string,
  fenceLine: (engineLine: number) => number = (n) => n,
): string | null {
  const lines = svgTextLines(svg);
  const nonBlank = lines.map((l) => l.trim()).filter((l) => l !== '');
  if (nonBlank.length === 0) return null;

  if (nonBlank[0].startsWith('PlantUML version')) {
    const from = nonBlank.findIndex((l) => FROM_LINE.test(l));
    if (from !== -1) {
      const line = fenceLine(Number(FROM_LINE.exec(nonBlank[from])![1]));
      const message = nonBlank[nonBlank.length - 1];
      return `line ${line}: ${message}`;
    }
  }
  if (nonBlank[0] === NOT_SUPPORTED) {
    const directive = nonBlank.findIndex((l) => l.startsWith('Sorry, but the following directive'));
    const what = directive !== -1 ? nonBlank[directive + 1] : undefined;
    return what ? `${NOT_SUPPORTED}: ${what}` : NOT_SUPPORTED;
  }
  const crash = nonBlank.findIndex((l) => l.startsWith('An error has occurred'));
  if (crash !== -1) return nonBlank.slice(crash, crash + 2).join('\n');
  return null;
}

/** The text a `@plantuml/core` error arrives as: a Java exception, prefixed. */
export function formatPlantUmlError(message: string): string {
  return message.replace(/^(?:[a-z]+\.)+[A-Za-z]*(?:Exception|Error):\s*/, '');
}

/**
 * Render one fence on `engine`, themed by `preamble`. Resolves with the SVG;
 * rejects with a readable message for a bad source or an engine failure. The
 * engine keeps shared state, so calls must not overlap (see `serialQueue.ts`).
 */
export function renderPlantUml(
  engine: PlantUmlLike,
  source: string,
  preamble: readonly string[],
): Promise<string> {
  const input = plantumlInput(source, preamble);
  return new Promise<string>((resolve, reject) => {
    try {
      engine.renderToString(
        input.lines,
        (svg) => {
          const error = plantumlDiagramError(svg, input.fenceLine);
          if (error === null) resolve(svg);
          else reject(new Error(error));
        },
        (message) => reject(new Error(formatPlantUmlError(String(message)))),
      );
    } catch (err) {
      reject(new Error(formatPlantUmlError(err instanceof Error ? err.message : String(err))));
    }
  });
}

/**
 * True when a source uses an emoji (`<:smile:>`, `<:1f600:>`). The emoji
 * table is 1.9 MB, so it loads only for a source that needs it.
 */
export function usesEmoji(source: string): boolean {
  return /<:[0-9a-z_+-]+:>/i.test(source) || /<#\w+:[0-9a-z_+-]+:>/i.test(source);
}
