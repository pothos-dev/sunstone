<script lang="ts">
  // Frontmatter Properties panel (ADR 0003, structured frontmatter model).
  //
  // Renders the focused Concept's frontmatter as typed inputs above the editor
  // body:
  //   - scalar  -> single text input
  //   - list    -> chip input (add/remove)
  //   - complex -> read-only raw textarea, preserved verbatim
  //
  // The structured `properties` are the single source of truth (held in the
  // editor's `frontmatterField`). Editing produces a NEW `Property[]` and reports
  // it through `onchange`; the app shell dispatches it into the field and the
  // editor recombines `serialize(props) + body` for autosave.

  import { type Property } from '$lib/frontmatter';
  import {
    addChipAt,
    appendProperty,
    commitKeyEdit,
    removeChipAt,
    removePropertyAt,
    setListAt,
    setScalarAt,
  } from '$lib/propertiesEdits';
  import { focus } from '$lib/state/focus.svelte';
  import { propertiesNav, KEY_COL, VALUE_COL, type CellKind } from '$lib/state/propertiesNav.svelte';
  import { moveCell, nextCellTab, type Cell } from '$lib/propertiesGrid';
  import PropertyRow from './PropertyRow.svelte';
  import PropertiesAddRow from './PropertiesAddRow.svelte';

  interface Props {
    /** The open Concept's frontmatter properties (source of truth). */
    properties: Property[];
    /** Bundle-relative path of the open Concept (for the reserved-file exemption). */
    path: string | null;
    /** Existing Bundle `type` values, for the `type` field's autocomplete. */
    types?: string[];
    /**
     * Key-name suggestions for the key inputs (when adding/renaming a key):
     * OKF recommended keys ∪ distinct keys used across the Bundle. Merged and
     * deduped by the caller (Tile.svelte).
     */
    keys?: string[];
    /**
     * Tag-value suggestions for list (chip) inputs: distinct tag values used
     * across the Bundle. No OKF tag vocabulary exists, so this is bundle-sourced
     * only. Applied to every list field's chip input (`tags` and any other list).
     */
    tags?: string[];
    /**
     * When true, focus the `type` input on mount/path-change. Driven by TreeCrud
     * (via the `focusTypeForPath` $bindable chain) right after a NEW Concept is
     * created so the user lands in `type`.
     */
    focusType?: boolean;
    /** Called with the new properties after an edit. */
    onchange: (props: Property[]) => void;
    /**
     * Whether this panel belongs to the ACTIVE tile (slice: multi-concept-tiling).
     * When the global Properties toggle is on, EVERY visible tile renders its own
     * Properties inline, but only the active tile's panel is wired to the single
     * `properties` Region + the singleton `propertiesNav` grid cursor. A
     * non-active panel is mouse-editable (its inputs still dispatch through
     * `onchange`) but takes no part in keyboard grid nav / the spotlight ring, so
     * the two never fight over the shared cursor. Clicking a non-active panel
     * activates its tile (Tile's pointer handler), promoting it to the interactive
     * one.
     */
    active?: boolean;
  }

  let {
    properties,
    path,
    types = [],
    keys = [],
    tags = [],
    focusType = false,
    onchange,
    active = true,
  }: Props = $props();

  // The `type` input element, focused when a new Concept opens so the user
  // lands in `type` (the field they must fill to make the Concept OKF-valid).
  let typeInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    // Re-focus when the requested-focus flag is set for the open path.
    void path;
    if (focusType && typeInput) {
      typeInput.focus();
      typeInput.select();
    }
  });

  // Stable per-row view-models. Rows are keyed by a positional `id` rather than
  // by `prop.key`, so editing a key char-by-char (a LOCAL draft, committed only
  // on blur/Enter) never re-keys the row and steals focus. Position is stable
  // across re-parse (the serializer preserves document order) and the array is
  // rebuilt wholesale on every change, so the id never desyncs from its prop.
  const rows = $derived(properties.map((prop, id) => ({ id, prop })));

  // Draft text for the per-list "add chip" inputs, keyed by ROW ID (the
  // positional index), not by `prop.key`. Keying by id means a duplicate key
  // (from an externally-authored file) gets a distinct draft per row, and the
  // draft always attaches to the row actually being edited.
  let chipDrafts = $state<Record<number, string>>({});

  // Local draft text for the key inputs, keyed by row id. `undefined` means the
  // input shows the live key; a string means the user is mid-edit. We reset a
  // draft once it matches the (possibly newly-committed) live key again.
  let keyDrafts = $state<Record<number, string>>({});

  // Row id of a freshly ADDED property awaiting its first key commit. It opens
  // with the key input focused and empty; blurring it empty DISCARDS the row
  // (slice: add-property-text-or-list). `null` when no add is pending. New rows
  // are appended, so the new id is always the last index (`properties.length`).
  let newRowId = $state<number | null>(null);

  /**
   * Append a new property and mark its row for auto-focus + discard-on-empty.
   * The created KIND is fixed (no after-the-fact conversion). The new row lands
   * at the end of `properties`, so its positional id is the current length.
   */
  function addProperty(prop: Property) {
    newRowId = properties.length;
    onchange(appendProperty(properties, prop));
  }

  function addText() {
    addProperty({ key: '', kind: 'scalar', scalar: '' });
  }

  function addList() {
    addProperty({ key: '', kind: 'list', list: [] });
  }

  /**
   * Focus action for a row's key input. Focuses + selects only the just-added
   * row (`newRowId`), so adding a property lands the cursor in its empty key.
   */
  function autofocusKey(node: HTMLInputElement, id: number) {
    if (id === newRowId) {
      node.focus();
      node.select();
    }
    return {};
  }

  function keyDraftValue(id: number, liveKey: string): string {
    const d = keyDrafts[id];
    return d === undefined ? liveKey : d;
  }

  /**
   * Commit a key rename for the row at `id` (blur / Enter). The discard/revert
   * rules live in `$lib/propertiesEdits` (`commitKeyEdit`); here we only manage
   * the local draft + new-row bookkeeping.
   */
  function commitKey(id: number) {
    if (!properties[id]) return;
    const isNew = id === newRowId;
    const next = commitKeyEdit(properties, id, keyDrafts[id], isNew);
    // Clear the draft regardless of outcome (revert reverts to the live key).
    delete keyDrafts[id];
    if (isNew) newRowId = null;
    if (next !== null) onchange(next);
  }

  /** Abandon an in-progress key edit (Escape), reverting to the live key. */
  function cancelKey(id: number) {
    delete keyDrafts[id];
  }

  function onKeyKeydown(event: KeyboardEvent, id: number) {
    if (event.key === 'Enter') {
      event.preventDefault();
      (event.currentTarget as HTMLInputElement).blur(); // triggers commit
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelKey(id);
      (event.currentTarget as HTMLInputElement).blur();
    }
  }

  /** Remove the property at row `id`. */
  function deleteProperty(id: number) {
    delete keyDrafts[id];
    onchange(removePropertyAt(properties, id));
  }

  // Value edits address the row by its positional `id` (the array index), NOT by
  // `prop.key`. With duplicate keys forbidden in-app, key and id agree; but an
  // externally-authored file can still carry duplicate keys, and addressing by
  // id targets the exact row being edited rather than the first key match. The
  // id ↔ array-index contract holds: `properties` is rebuilt wholesale on every
  // change (document order preserved), so the index never desyncs from its prop.

  /** Replace the value of the scalar property at row `id`. */
  function editScalar(id: number, value: string) {
    onchange(setScalarAt(properties, id, value));
  }

  /** Set the items of the list property at row `id`. */
  function setListItems(id: number, items: string[]) {
    onchange(setListAt(properties, id, items));
  }

  function addChip(id: number, current: string[]) {
    const next = addChipAt(properties, id, current, chipDrafts[id] ?? '');
    if (next === null) return;
    onchange(next);
    chipDrafts[id] = '';
  }

  function removeChip(id: number, current: string[], index: number) {
    onchange(removeChipAt(properties, id, current, index));
  }

  function onChipKeydown(event: KeyboardEvent, id: number, current: string[]) {
    if (event.key === 'Enter') {
      event.preventDefault();
      addChip(id, current);
    }
  }

  // --- Grid keyboard navigation (slice: properties-grid-navigation) ---
  //
  // The panel is a spreadsheet-style 2-column grid (key | value); the Focused
  // item is a CELL with two modes (nav = wrapper focused / edit = input focused).
  // The `propertiesNav` store holds the cursor + mode and the pure key handling
  // (cell-index math in `$lib/propertiesGrid`); here we supply the side-effects
  // (enter edit, commit/cancel the draft, add/delete a row, nav-mode clipboard)
  // and mirror the cursor into DOM focus while the Properties Region is active.

  // The panel root, so we can query its cell wrappers + inputs for focus.
  let panel = $state<HTMLElement | null>(null);

  /** The VALUE-cell kind at a row (drives Enter behaviour + edit routing). */
  function valueKindAt(row: number): CellKind {
    const p = properties[row];
    if (!p) return 'scalar';
    return p.kind === 'list' ? 'list' : p.kind === 'complex' ? 'raw' : 'scalar';
  }

  /** Whether a row id is the Focused cell's row (for roving tabindex). */
  function isFocusedRow(id: number): boolean {
    return propertiesNav.cell.row === id;
  }

  // The add-controls row ("+ Text" / "+ List") is a navigable grid row sitting
  // one past the last data row, so the cursor can land on it (↓ from the last
  // row) and the buttons share the cells' roving-tabindex + spotlight model.
  const addRowIndex = $derived(properties.length);

  // The nav-mode spotlight ring is shown ONLY while the Properties Region is the
  // active Region. The Focused cell (`propertiesNav.cell`) is remembered as the
  // roving tab target even when focus is elsewhere, but a remembered cursor in
  // an UNFOCUSED Region must not paint a second spotlight (mirrors the
  // `:focus-within`-gated rings in the Explorer / Outline / Backlinks / Tags).
  const propsActive = $derived(active && focus.focusedRegion === 'properties');

  /** Whether the add button in `col` is the Focused cell (roving tabindex / ring). */
  function addBtnFocused(col: 0 | 1): boolean {
    return propertiesNav.cell.row === addRowIndex && propertiesNav.cell.col === col;
  }

  /**
   * Find the navigable element for `cell`, if rendered. This is the cell WRAPPER
   * for a data row, or the "+ Text" / "+ List" BUTTON for the add-controls row
   * (row index === `properties.length`) — both carry the `data-cell-row` /
   * `data-cell-col` coordinates, so a single attribute query addresses either.
   */
  function cellEl(cell: Cell): HTMLElement | null {
    return (
      panel?.querySelector<HTMLElement>(
        `[data-cell-row="${cell.row}"][data-cell-col="${cell.col}"]`,
      ) ?? null
    );
  }

  /** Find the editable <input>/<textarea> inside the cell at `cell`. */
  function cellInputEl(cell: Cell): HTMLElement | null {
    return cellEl(cell)?.querySelector<HTMLElement>('input, textarea') ?? null;
  }

  /**
   * Imperatively focus the cell WRAPPER for `cell` (nav mode). Used after a
   * commit/cancel that blurred the edit input — blurring drops focus OUT of the
   * Region (focusedRegion → null), so the focus-mirror effect won't fire; we
   * place focus directly. Deferred a microtask so the roving `tabindex=0` has
   * flipped onto the destination wrapper (and any row re-parse settled) first.
   */
  function focusCell(cell: Cell) {
    queueMicrotask(() => {
      const el = cellEl(cell);
      if (el && document.activeElement !== el) el.focus();
    });
  }

  // Mirror the cursor into DOM focus while the Properties Region holds focus.
  // Nav mode → focus the cell WRAPPER (the input is left unfocused); edit mode is
  // driven imperatively by `enterEdit` (focusing the input) so this effect only
  // owns nav-mode placement. Leaving the Region resets the mode to nav so a later
  // re-entry (Alt+↑) lands in nav mode on the remembered cell, per the ticket.
  $effect(() => {
    // Only the active tile's panel drives the singleton cursor into DOM focus;
    // a non-active panel takes no part in grid nav (see the `active` prop).
    if (!active) return;
    if (focus.focusedRegion !== 'properties') {
      if (propertiesNav.mode !== 'nav') propertiesNav.mode = 'nav';
      return;
    }
    void propertiesNav.cell;
    if (propertiesNav.mode !== 'nav') return;
    const el = cellEl(propertiesNav.cell);
    if (el && document.activeElement !== el) el.focus();
  });

  // Keep the cursor in range as rows are added/deleted or the Concept switches.
  // Only the active panel clamps: the cursor is shared, and a non-active panel
  // with a different row count would otherwise churn it.
  $effect(() => {
    if (active) propertiesNav.clamp(properties.length);
  });

  /** Click a cell wrapper → make it the Focused cell in nav mode. */
  function onCellMousedown(row: number, col: 0 | 1) {
    propertiesNav.setCell({ row, col });
  }

  // Sync the grid cursor + mode to wherever focus actually lands inside the
  // panel. Keyboard navigation drives focus through the store, but a mouse click
  // or a programmatic `.focus()` (e.g. the existing tests, or the type-autofocus
  // on a new Concept) focuses an input/wrapper directly — this keeps `mode`
  // (nav vs edit) and `cell` honest in those cases so the keydown router and the
  // focus-mirror effect agree with reality. Focusing an <input>/<textarea> inside
  // a cell → EDIT mode on that cell; focusing a cell wrapper → NAV mode.
  function onPanelFocusIn(e: FocusEvent) {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const cellEl = target.closest<HTMLElement>('[data-cell-row]');
    if (!cellEl) return;
    const row = Number(cellEl.dataset.cellRow);
    const col = (Number(cellEl.dataset.cellCol) === VALUE_COL ? VALUE_COL : KEY_COL) as 0 | 1;
    if (propertiesNav.cell.row !== row || propertiesNav.cell.col !== col) {
      propertiesNav.cell = { row, col };
    }
    // Chip sub-nav (slice: properties-chip-subnavigation) owns its own mode +
    // roving focus across the strip (chips + the new-tag input). While we're in
    // `chips`/`edit` for THIS list cell, don't clobber the mode here: PropertyRow
    // moves focus between strip elements (a chip button is non-editable, the
    // new-tag input is editable) and would otherwise flip nav/edit spuriously.
    const isChip = target.dataset.chipIndex !== undefined;
    const inThisCellStrip =
      propertiesNav.mode !== 'nav' && propertiesNav.cell.row === row && col === VALUE_COL;
    if (isChip || inThisCellStrip) return;
    const editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    const mode = editable ? 'edit' : 'nav';
    if (propertiesNav.mode !== mode) propertiesNav.mode = mode;
  }

  /** Enter edit mode on a cell: focus its input/textarea. */
  function enterEdit(cell: Cell) {
    queueMicrotask(() => {
      const input = cellInputEl(cell);
      if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
      } else {
        input?.focus();
      }
    });
  }

  /** Commit the draft of the cell currently in edit mode (blur triggers it). */
  function commitFocusedCell(cell: Cell) {
    const input = cellInputEl(cell);
    // Blur runs the existing per-input commit (commitKey / scalar onchange /
    // addChip). We then re-focus the destination cell wrapper via the effect.
    if (input instanceof HTMLElement) input.blur();
  }

  /** Cancel the draft of the cell in edit mode (Escape), reverting it. */
  function cancelFocusedCell(cell: Cell) {
    if (cell.col === KEY_COL) {
      cancelKey(cell.row);
    } else if (valueKindAt(cell.row) === 'scalar') {
      // Scalars have no separate draft state — revert the live input value, then
      // blur WITHOUT committing the reverted text as a fresh edit.
      const input = cellInputEl(cell);
      const p = properties[cell.row];
      if (input instanceof HTMLInputElement && p) input.value = p.scalar ?? '';
    }
    const input = cellInputEl(cell);
    if (input instanceof HTMLElement) input.blur();
  }

  /** Nav-mode Ctrl+C: copy the focused cell's value as a string. */
  function copyCell(cell: Cell) {
    const p = properties[cell.row];
    if (!p) return;
    const text =
      cell.col === KEY_COL
        ? p.key
        : p.kind === 'list'
          ? (p.list ?? []).join(', ')
          : p.kind === 'complex'
            ? (p.raw ?? '')
            : (p.scalar ?? '');
    void navigator.clipboard?.writeText?.(text);
  }

  /** Nav-mode Ctrl+V: paste the clipboard into the focused cell as a string. */
  function pasteCell(cell: Cell) {
    const p = properties[cell.row];
    if (!p) return;
    void navigator.clipboard?.readText?.().then((text) => {
      const value = text ?? '';
      if (cell.col === KEY_COL) {
        keyDrafts[cell.row] = value;
        commitKey(cell.row);
      } else if (p.kind === 'list') {
        setListItems(cell.row, [...(p.list ?? []), value]);
      } else if (p.kind === 'scalar') {
        editScalar(cell.row, value);
      }
      // raw cells are read-only: paste is a no-op.
    });
  }

  /** Container-level keydown: route by mode. Bubbles from the cell inputs too. */
  function onGridKeydown(e: KeyboardEvent) {
    // CHIPS mode (list value cell sub-nav) is owned entirely by PropertyRow,
    // which handles the strip keys locally and stops their propagation. Any key
    // that DOES bubble up here (e.g. an unhandled one) must NOT be routed to the
    // nav handler — `d`/arrows there would act on the GRID, not the chip strip.
    if (propertiesNav.mode === 'chips') return;
    if (propertiesNav.mode === 'edit') {
      if (handleEditKeydown(e)) e.preventDefault();
      return;
    }
    const handled = propertiesNav.handleNavKeydown(e, {
      rowCount: () => properties.length,
      valueKind: valueKindAt,
      enterEdit,
      addRow: addText,
      addList,
      deleteRow: (row) => deleteRowByIndex(row),
      copyCell,
      pasteCell,
    });
    if (handled) e.preventDefault();
  }

  /**
   * Edit-mode keydown routing. The mode-transition keys differ by cell kind:
   *   - key cells + scalar value cells: Enter commits + moves DOWN; Tab commits +
   *     moves RIGHT; Escape cancels to nav (same cell).
   *   - list value cells: Enter is the native chip-add (left alone); Tab still
   *     commits + moves right; Escape exits to nav.
   *   - raw value cells: read-only; Enter/Tab leave native behaviour, Escape exits.
   * Returns true when handled (caller preventDefaults).
   */
  function handleEditKeydown(e: KeyboardEvent): boolean {
    if (e.altKey || e.ctrlKey || e.metaKey) return false; // native incl. copy/paste
    const cell = propertiesNav.cell;
    const rowCount = properties.length;
    const isListValue = cell.col === VALUE_COL && valueKindAt(cell.row) === 'list';
    const isRawValue = cell.col === VALUE_COL && valueKindAt(cell.row) === 'raw';

    if (e.key === 'Escape') {
      cancelFocusedCell(cell);
      propertiesNav.toNav(cell);
      focusCell(cell);
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey && !isListValue && !isRawValue) {
      commitFocusedCell(cell);
      const dest = moveCell(cell, 'down', rowCount);
      propertiesNav.toNav(dest);
      focusCell(dest);
      return true;
    }
    if (e.key === 'Tab' && !e.shiftKey && !isRawValue) {
      commitFocusedCell(cell);
      const dest = nextCellTab(cell, rowCount);
      propertiesNav.toNav(dest);
      focusCell(dest);
      return true;
    }
    return false;
  }

  /**
   * Delete the row at array index `row` (nav-mode `d`). Mirrors the per-row
   * delete button (`deleteProperty`) but addresses by the cursor's row index.
   */
  function deleteRowByIndex(row: number) {
    if (properties[row]) deleteProperty(row);
  }

  // When a NEW row is added in nav mode (`a`), drop into edit mode on its key
  // cell. `addProperty` sets `newRowId` to the appended index; reflect that into
  // the cursor + mode so the focus effect / autofocus land in the key input.
  $effect(() => {
    const id = newRowId;
    if (id === null || !active) return;
    propertiesNav.cell = { row: id, col: KEY_COL };
    propertiesNav.mode = 'edit';
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<section
  class="properties"
  aria-label="Properties"
  data-testid="properties"
  role="grid"
  bind:this={panel}
  onkeydown={onGridKeydown}
  onfocusin={onPanelFocusIn}
>
  <!-- The property grid + add controls. Rendering is gated by the GLOBAL
       Properties toggle (session.propertiesShown) up in Tile.svelte, so there is
       no per-panel collapse chrome here: when the panel renders at all, its
       frontmatter shows inline. -->
    {#each rows as { id, prop } (id)}
    {@const isType = prop.key === 'type'}
    {@const keyFocused = isFocusedRow(id) && propertiesNav.cell.col === KEY_COL}
    {@const valueFocused = isFocusedRow(id) && propertiesNav.cell.col === VALUE_COL}
    <div class="row" data-key={prop.key}>
      <!-- KEY cell: the roving-tabindex wrapper is the nav-mode focus target;
           the <input> inside it is the edit-mode target. -->
      <div
        class="key cell"
        class:cell-active={keyFocused && propertiesNav.mode === 'nav' && propsActive}
        data-testid={`cell-key-${id}`}
        data-cell-row={id}
        data-cell-col={KEY_COL}
        tabindex={active && keyFocused && propertiesNav.mode === 'nav' ? 0 : -1}
        role="gridcell"
        aria-label={`Property name: ${prop.key}`}
        onmousedown={() => onCellMousedown(id, KEY_COL)}
      >
        <input
          class="key-input"
          type="text"
          tabindex="-1"
          aria-label={`Property name: ${prop.key}`}
          data-testid={`key-${prop.key}`}
          list="key-suggestions"
          value={keyDraftValue(id, prop.key)}
          use:autofocusKey={id}
          oninput={(e) => (keyDrafts[id] = (e.currentTarget as HTMLInputElement).value)}
          onblur={() => commitKey(id)}
          onkeydown={(e) => onKeyKeydown(e, id)}
        />
        <button
          type="button"
          class="row-remove"
          tabindex="-1"
          aria-label={`Delete ${prop.key}`}
          data-testid={`delete-${prop.key}`}
          onclick={() => deleteProperty(id)}>×</button
        >
      </div>

      <!-- VALUE cell wrapper: same two-mode model. -->
      <div
        class="cell value-cell"
        class:cell-active={valueFocused && propertiesNav.mode === 'nav' && propsActive}
        data-testid={`cell-value-${id}`}
        data-cell-row={id}
        data-cell-col={VALUE_COL}
        tabindex={active && valueFocused && propertiesNav.mode === 'nav' ? 0 : -1}
        role="gridcell"
        onmousedown={() => onCellMousedown(id, VALUE_COL)}
      >
        <PropertyRow
          {id}
          {prop}
          {isType}
          {types}
          {editScalar}
          {addChip}
          {removeChip}
          {onChipKeydown}
          bind:chipDraft={chipDrafts[id]}
          bind:typeInput
        />
      </div>
    </div>
  {/each}

  <!-- Shared autocomplete sources. The key datalist is referenced by every key
       input (`list="key-suggestions"`): OKF recommended keys ∪ keys used
       elsewhere in the Bundle. The tag datalist backs every list field's chip
       input (`list="tag-suggestions"`): distinct bundle tag values (no fixed
       OKF tag vocabulary). Both refresh via App.svelte on `indexStore.version`. -->
  <datalist id="key-suggestions" data-testid="key-suggestions">
    {#each keys as k (k)}
      <option value={k}></option>
    {/each}
  </datalist>
  <datalist id="tag-suggestions" data-testid="tag-suggestions">
    {#each tags as t (t)}
      <option value={t}></option>
    {/each}
  </datalist>

    <PropertiesAddRow
      {addRowIndex}
      textFocused={active && addBtnFocused(KEY_COL)}
      textActive={addBtnFocused(KEY_COL) && propsActive}
      listFocused={active && addBtnFocused(VALUE_COL)}
      listActive={addBtnFocused(VALUE_COL) && propsActive}
      onAddText={addText}
      onAddList={addList}
    />
</section>

<style>
  .properties {
    padding: 0.6rem 1.5rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-family: var(--font-ui);
    font-size: 0.85rem;
    background: var(--bg-sunken);
  }

  .row {
    display: grid;
    grid-template-columns: 9rem 1fr;
    align-items: start;
    gap: 0.6rem;
  }

  .key {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--text-muted);
    overflow-wrap: anywhere;
    min-width: 0;
  }

  /* Grid cell wrappers (slice: properties-grid-navigation). The wrapper is the
     roving-tabindex nav-mode focus target; its inner input is the edit-mode
     target. In nav mode the focused cell shows the spotlight ring on the
     wrapper; entering edit mode focuses the input (which keeps its own ring). */
  .cell {
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
  }

  .cell:focus,
  .cell:focus-visible {
    outline: none;
  }

  .cell.cell-active {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .value-cell {
    min-width: 0;
  }

  .key-input {
    flex: 1 1 auto;
    min-width: 0;
    font-family: var(--font-ui);
    font-size: inherit;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: 0.25rem 0.3rem;
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease,
      background-color 0.15s ease;
  }

  .key-input:hover {
    border-color: var(--border-strong);
  }

  .key-input:focus,
  .key-input:focus-visible {
    outline: none;
    color: var(--text);
    background: var(--bg-elevated);
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .row-remove {
    flex: 0 0 auto;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.2rem;
    border-radius: var(--radius-sm);
    opacity: 0;
    transition:
      background-color 0.15s ease,
      opacity 0.15s ease;
  }

  .row:hover .row-remove,
  .row:focus-within .row-remove {
    opacity: 1;
  }

  .row-remove:hover {
    background: var(--hover);
    color: var(--danger);
  }
</style>
