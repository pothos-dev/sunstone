/**
 * Hand-drawn context-menu icons, kept as inner SVG markup so both
 * `MenuIcon.svelte` (our `ContextMenu`) and plain DOM (atomic-editor's table
 * cell menu, see `editor/tableMenuIcons.ts`) can render them.
 *
 * Every glyph is drawn on a 16×16 grid as a stroked outline; `menuIconSvg`
 * supplies the shared stroke attributes and `currentColor`, so an icon follows
 * its menu item's text colour (incl. the danger state).
 */

export const MENU_ICONS = {
  // ---- clipboard ----
  cut:
    '<circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/>' +
    '<path d="M6 10 12 2.5M10 10 4 2.5"/>',
  copy:
    '<rect x="5.5" y="5.5" width="8" height="8" rx="1.25"/>' +
    '<path d="M3.5 10.5H3.25a1 1 0 0 1-1-1V3.25a1 1 0 0 1 1-1H9.5a1 1 0 0 1 1 1v.25"/>',
  paste:
    '<path d="M5.5 3H4.25A1.25 1.25 0 0 0 3 4.25v8.5A1.25 1.25 0 0 0 4.25 14h7.5A1.25 1.25 0 0 0 13 12.75v-8.5A1.25 1.25 0 0 0 11.75 3H10.5"/>' +
    '<rect x="5.5" y="1.75" width="5" height="2.5" rx=".75"/>',

  // ---- formatting ----
  bold: '<path stroke-width="1.7" d="M4.75 2.75h3.75a2.6 2.6 0 0 1 0 5.2H4.75zM4.75 7.95h4.5a2.65 2.65 0 0 1 0 5.3h-4.5z"/>',
  italic: '<path d="M7 2.75h5M4 13.25h5M9.75 2.75l-3.5 10.5"/>',
  strike:
    '<path d="M2.5 8h11"/>' +
    '<path d="M11 4.25C10.5 3.2 9.4 2.6 8 2.6c-1.8 0-3.1.95-3.1 2.35 0 .8.4 1.5 1.3 2"/>' +
    '<path d="M10.6 9.6c.4.45.6.95.6 1.55 0 1.45-1.35 2.3-3.2 2.3-1.5 0-2.7-.6-3.3-1.65"/>',
  code: '<path d="M5.25 4.5 1.75 8l3.5 3.5M10.75 4.5l3.5 3.5-3.5 3.5M9 3 7 13"/>',
  link:
    '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.4-2.4a2.6 2.6 0 0 0-3.7-3.7l-.9.9"/>' +
    '<path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.1 9.2a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/>',

  // ---- comments ----
  commentAdd:
    '<path d="M4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3.5 2.75V11A1 1 0 0 1 2.5 10V4A1.5 1.5 0 0 1 4 2.5z"/>' +
    '<path d="M8 4.75v4M6 6.75h4"/>',
  commentRemove:
    '<path d="M4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3.5 2.75V11A1 1 0 0 1 2.5 10V4A1.5 1.5 0 0 1 4 2.5z"/>' +
    '<path d="m6.5 5.25 3 3M9.5 5.25l-3 3"/>',

  // ---- tree ----
  newConcept:
    '<path d="M9 1.75H4.5A1.25 1.25 0 0 0 3.25 3v10a1.25 1.25 0 0 0 1.25 1.25h7A1.25 1.25 0 0 0 12.75 13V5.5zM9 1.75V5.5h3.75"/>' +
    '<path d="M8 7.75v4M6 9.75h4"/>',
  newFolder:
    '<path d="M1.75 4A1.25 1.25 0 0 1 3 2.75h3l1.5 1.75H13a1.25 1.25 0 0 1 1.25 1.25v6.5A1.25 1.25 0 0 1 13 13.5H3a1.25 1.25 0 0 1-1.25-1.25z"/>' +
    '<path d="M8 6.75v4.5M5.75 9h4.5"/>',
  // Same shapes as ReservedGlyph's `index` / `log`.
  index:
    '<rect x="3" y="2" width="10" height="12" rx="1.5"/>' +
    '<path d="M5.5 6h5M5.5 8.5h5M5.5 11h3"/>',
  log: '<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.25 1.5"/>',
  rename:
    '<path d="M10.5 2.7 13.3 5.5 5.6 13.2 2.5 13.5 2.8 10.4z"/>' +
    '<path d="M9.2 4 12 6.8"/>',
  move:
    '<path d="M1.75 4A1.25 1.25 0 0 1 3 2.75h3l1.5 1.75H13a1.25 1.25 0 0 1 1.25 1.25v6.5A1.25 1.25 0 0 1 13 13.5H3a1.25 1.25 0 0 1-1.25-1.25z"/>' +
    '<path d="M5.25 9h5M8.5 7l2 2-2 2"/>',
  delete:
    '<path d="M2.5 4h11M6 4V2.75A.75.75 0 0 1 6.75 2h2.5a.75.75 0 0 1 .75.75V4"/>' +
    '<path d="m3.75 4 .7 9.1a1.25 1.25 0 0 0 1.25 1.15h4.6a1.25 1.25 0 0 0 1.25-1.15L12.25 4"/>' +
    '<path d="M6.75 7v4.5M9.25 7v4.5"/>',

  // ---- table (a 2×2 grid plus a marker on the affected side) ----
  rowAbove:
    '<rect x="2.5" y="7" width="11" height="6.5" rx="1"/><path d="M2.5 10.25h11M8 7v6.5"/>' +
    '<path d="M8 1.5v3.5M6.25 3.25h3.5"/>',
  rowBelow:
    '<rect x="2.5" y="2.5" width="11" height="6.5" rx="1"/><path d="M2.5 5.75h11M8 2.5V9"/>' +
    '<path d="M8 11v3.5M6.25 12.75h3.5"/>',
  rowDelete:
    '<rect x="2.5" y="2.5" width="11" height="6.5" rx="1"/><path d="M2.5 5.75h11M8 2.5V9"/>' +
    '<path d="m6.5 11.25 3 3M9.5 11.25l-3 3"/>',
  colLeft:
    '<rect x="7" y="2.5" width="6.5" height="11" rx="1"/><path d="M10.25 2.5v11M7 8h6.5"/>' +
    '<path d="M1.5 8H5M3.25 6.25v3.5"/>',
  colRight:
    '<rect x="2.5" y="2.5" width="6.5" height="11" rx="1"/><path d="M5.75 2.5v11M2.5 8H9"/>' +
    '<path d="M11 8h3.5M12.75 6.25v3.5"/>',
  colDelete:
    '<rect x="2.5" y="2.5" width="6.5" height="11" rx="1"/><path d="M5.75 2.5v11M2.5 8H9"/>' +
    '<path d="m11.25 6.5 3 3M14.25 6.5l-3 3"/>',
} as const;

export type MenuIconName = keyof typeof MENU_ICONS;

/** A complete `<svg>` for `name`, sized `size` px, drawn in `currentColor`. */
export function menuIconSvg(name: MenuIconName, size = 14): string {
  return (
    `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true" ` +
    'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' +
    MENU_ICONS[name] +
    '</svg>'
  );
}
