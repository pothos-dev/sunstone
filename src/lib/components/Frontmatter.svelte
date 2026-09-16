<script lang="ts">
  // The Frontmatter Region (ADR 0008, superseding ADR 0003's Properties panel).
  //
  // Hosts the open Concept's frontmatter as YAML TEXT in its own small
  // CodeMirror (`$lib/editor/frontmatterEditor`), with the `---` fences drawn
  // here as Region chrome — the editor holds the INNER block only, so what the
  // user edits is exactly what is written back.
  //
  // The YAML is NOT this component's state: it lives in the body editor's
  // `frontmatterField` (the `host` view), which owns the single undo history for
  // the whole Concept. This component mirrors it in and lets the editor module
  // push edits back out.
  //
  // Rendering is gated by the GLOBAL Frontmatter toggle (session.frontmatterShown,
  // off by default) up in Tile.svelte, so a collapsed Region costs nothing: the
  // editor is not built and the YAML grammar chunk is never fetched.

  import { onDestroy } from 'svelte';
  import type { EditorView } from '@codemirror/view';
  import {
    buildFrontmatterEditor,
    formatFrontmatter,
    type FrontmatterEditor,
  } from '$lib/editor/cm';
  import { yamlError } from '$lib/frontmatter';
  import { PARSE_ERROR_DELAY_MS } from '$lib/editor/parseErrorDelay';

  interface Props {
    /** The body editor: owner of the frontmatter field and the undo history. */
    host: EditorView | null;
    /** The open Concept's frontmatter YAML, mirrored out of `host`. */
    yaml: string;
    /** Read mode: same YAML, verbatim and highlighted, but not editable. */
    readOnly: boolean;
    /** Inner Escape layer: leave YAML editing, keep the Region focused. */
    onEscape: () => void;
    /** Focus left the YAML (desktop flushes the pending write here). */
    onBlur?: () => void;
  }

  let { host, yaml, readOnly, onEscape, onBlur }: Props = $props();

  let editorParent = $state<HTMLDivElement | null>(null);
  let editor: FrontmatterEditor | null = null;
  // `editor` itself is not reactive (a CodeMirror handle, mutated through its
  // own API). This flag is: it makes the mirror/read-only effects below re-run
  // the moment the editor exists, so an editor built AFTER the last `yaml`
  // change still gets seeded with it.
  let editorBuilt = $state(false);

  $effect(() => {
    // Read every dependency up front: an early return that never reaches `host`
    // or `yaml` would leave them out of this effect's dependency set, so a later
    // change to either would not re-run it and the editor would never be built.
    const parent = editorParent;
    const hostView = host;
    const initial = yaml;
    if (editor || !parent || !hostView) return;
    editor = buildFrontmatterEditor({
      parent,
      host: hostView,
      doc: initial,
      readOnly,
      onEscape,
      onBlur,
    });
    editorBuilt = true;
  });

  // Mirror host-side changes in: undo/redo, a Concept switch, an external
  // reload. `syncFromHost` is a no-op when the text already matches, so typing
  // here does not round-trip through this effect.
  $effect(() => {
    void editorBuilt;
    editor?.syncFromHost(yaml);
  });

  $effect(() => {
    void editorBuilt;
    editor?.setReadOnly(readOnly);
  });

  onDestroy(() => {
    editor?.destroy();
    editor = null;
    editorBuilt = false;
  });

  // The held-write indicator, debounced so it does not flash while typing (ADR
  // 0008 — a text editor is unparseable for most of the time a key is being
  // typed). Re-armed on every keystroke; the cleanup cancels the previous timer.
  let parseError = $state<string | null>(null);
  $effect(() => {
    const current = yaml;
    const timer = setTimeout(() => {
      parseError = yamlError(current)?.message ?? null;
    }, PARSE_ERROR_DELAY_MS);
    return () => clearTimeout(timer);
  });

  /**
   * Focus the YAML (the Region's entry point, and where an undo lands). With a
   * `key`, put the cursor at the END of that key's line — how a freshly
   * scaffolded Concept lands the author in `type`, which used to be the
   * Properties panel's `type` input (new-concept-scaffolding).
   */
  export function focus(key?: string): void {
    if (!editor) return;
    if (key !== undefined) {
      const at = endOfKeyLine(editor.view.state.doc.toString(), key);
      if (at !== null) editor.view.dispatch({ selection: { anchor: at } });
    }
    editor.focus();
  }

  /** Close any open typing group into its undo step (before an explicit save). */
  export function commitGroup(): void {
    editor?.commitGroup();
  }

  function format(): void {
    if (editor) formatFrontmatter(editor);
  }

  /** Offset just past `key:`'s value on its line, or `null` when absent. */
  function endOfKeyLine(doc: string, key: string): number | null {
    let offset = 0;
    for (const line of doc.split('\n')) {
      if (line.startsWith(`${key}:`)) return offset + line.length;
      offset += line.length + 1;
    }
    return null;
  }
</script>

<section class="frontmatter" data-testid="frontmatter" aria-label="Frontmatter">
  <div class="fence" data-testid="frontmatter-fence-open" aria-hidden="true">---</div>
  <div class="yaml-host" data-testid="frontmatter-editor" bind:this={editorParent}></div>
  <div class="footer">
    <span class="fence" data-testid="frontmatter-fence-close" aria-hidden="true">---</span>
    {#if !readOnly}
      <button
        type="button"
        class="format-btn"
        data-testid="frontmatter-format"
        title="Reflow the YAML block (Shift+Alt+F)"
        onclick={format}>Format</button
      >
    {/if}
  </div>
  {#if parseError}
    <p class="parse-error" data-testid="frontmatter-error" role="status">
      Invalid YAML — this Concept is not being saved. {parseError}
    </p>
  {/if}
</section>

<style>
  .frontmatter {
    padding: 0.6rem 1.5rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-family: var(--font-ui);
    font-size: 0.85rem;
    background: var(--bg-sunken);
  }

  /* The `---` delimiters are Region CHROME, not content: the editor below holds
     the inner block only, so they can never be edited away by accident. */
  .fence {
    font-family: var(--atomic-editor-font-mono, monospace);
    color: var(--fg-faint, var(--fg-muted));
    user-select: none;
    line-height: 1.4;
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
  }

  .format-btn {
    font: inherit;
    font-size: 0.75rem;
    color: var(--fg-muted);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 0.25rem;
    padding: 0.05rem 0.4rem;
    cursor: pointer;
  }

  .format-btn:hover {
    color: var(--fg);
    border-color: var(--border-strong);
  }

  .parse-error {
    margin: 0.2rem 0 0;
    font-size: 0.75rem;
    color: var(--danger);
  }

  .yaml-host :global(.cm-editor) {
    background: transparent;
    font-family: var(--atomic-editor-font-mono, monospace);
  }

  .yaml-host :global(.cm-editor.cm-focused) {
    outline: none;
  }

  .yaml-host :global(.cm-content) {
    padding: 0;
  }

  .yaml-host :global(.cm-line) {
    padding-left: 0;
  }
</style>
