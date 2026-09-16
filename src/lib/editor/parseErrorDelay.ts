/**
 * How long the frontmatter parse-error indicator waits after a keystroke.
 *
 * Lives in its own module so the Region's chrome can share the constant with the
 * in-editor linter WITHOUT importing `./yamlLanguage`, which is the lazily
 * loaded grammar chunk — importing it eagerly would defeat the point (ADR 0008:
 * nothing extra loads while the Region is collapsed).
 */
export const PARSE_ERROR_DELAY_MS = 1000;
