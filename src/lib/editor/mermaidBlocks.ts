import type { EditorState } from '@codemirror/state';
import { findDiagramBlocks, type DiagramBlock } from './diagramBlocks';
import { mermaidLanguage } from './mermaidLanguage';

// Mermaid-only views over the generic diagram fence detection
// (`diagramBlocks.ts`, dr-1). The render shell uses the generic detection
// directly; these narrow it to mermaid for callers and tests that ask about
// mermaid fences specifically.

/** A detected mermaid fence. */
export type MermaidBlock = DiagramBlock;

const MERMAID_ONLY = [mermaidLanguage];

/** Every ` ```mermaid ` fence in the document (see `findDiagramBlocks`). */
export function findMermaidBlocks(state: EditorState, parseMs = 200): MermaidBlock[] {
  return findDiagramBlocks(state, MERMAID_ONLY, parseMs);
}

/** True when the document contains at least one mermaid fence. */
export function hasMermaidBlock(state: EditorState, parseMs = 200): boolean {
  return findMermaidBlocks(state, parseMs).length > 0;
}

export { selectionTouches } from './diagramBlocks';
export {
  mermaidThemeConfig,
  mermaidCacheKey,
  type ResolvedTheme,
  type CssVarReader,
  type MermaidThemeConfig,
} from './mermaidTheme';
