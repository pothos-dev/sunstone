// The diagram language registry (dr-1, ADR-0014). Registering a language here
// makes its fences render in the editor (`editing` and `read`), in the web
// viewer and on paper — all three read this one list.

import type { DiagramLanguage } from './diagramLanguage';
import { mermaidLanguage } from './mermaidLanguage';

export const DIAGRAM_LANGUAGES: readonly DiagramLanguage[] = [mermaidLanguage];
