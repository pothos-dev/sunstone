# The Frontmatter lint lives in Rust, so `sunstone lint` and the editor share it

`sunstone lint [BUNDLE]` checks a whole Bundle from the command line: Frontmatter, links,
anchors, Embeds, footnotes and, in an OKF Bundle, conformance. The CLI is Rust, in both
binaries (the desktop's and `sunstone-cli`). The Frontmatter rules were TypeScript
(`src/lib/okf/lint.ts` and its families), kept there by
[ADR-0009](0009-marker-gated-okf-language-service.md) because `serde_yaml` gives no source
positions. We moved them into `sunstone-shared` (`okf_lint`). The editor now calls them over
wasm, and the CLI calls them natively, so a Concept the Frontmatter editor marks is the
Concept `sunstone lint` reports, and for the same reason.

## Considered Options

- **Port the rules to Rust and share them over wasm (chosen).** One rule set, in line with
  [ADR-0006](0006-wasm-shared-core-for-frontend-logic.md). Positions come from
  `saphyr-parser`, a pure-Rust YAML 1.2 parser that reports a span for every event and
  compiles for `wasm32`. `okf_lint::tree` builds a positioned node tree from those events,
  resolves plain scalars by the YAML 1.2 core schema (as the `yaml` package does, so
  `2026-06-30` stays a string and `1984` is a number), and reports duplicate keys itself.
- **A Rust twin of the TS rules for the CLI.** Rejected: it is exactly the drift ADR-0006
  exists to end. The editor and the CLI would disagree the first time someone changed one side.
- **Run the TS lint from the CLI.** Rejected: it would mean embedding a JavaScript engine in
  both binaries just for this.

## Consequences

- Rules are Rust, and the TypeScript test suites (`src/lib/okf/**/*.test.ts`) now run them
  through the shipped wasm. New rules go in `okf_lint/families.rs`, with goldens in its
  `tests.rs`.
- Completion stays TypeScript (`src/lib/okf/complete.ts` + `families/`). It reads a
  half-typed block by indentation rather than parsing it, so it never needed positions.
  A family's lint and completion halves share an id (`okf-trust`, …) but live in different
  languages.
- The editor's save gate (`isParseable`) still uses the `yaml` package, which ADR-0008's
  byte-preserving model needs. In rare edge cases the two parsers could disagree about
  well-formedness, but that would only change a lint finding, never whether a Concept saves.
- Finding offsets cross the seam in UTF-16 (the editor's unit), with a 1-based line beside
  them for the CLI.
- The marker gate is unchanged: `sunstone lint` applies OKF rules exactly where the editor
  does (`okf_version` on the root `index.md`, files inside that root, not reserved files).
