import { ViewPlugin, type EditorView } from '@codemirror/view';
import { menuIconSvg, type MenuIconName } from '$lib/menuIcons';

// Icons for atomic-editor's table cell context menu.
//
// `tables()` builds that menu itself as plain DOM (`openCellMenu` in its
// `table-widget.js`) and appends it to `document.body`; its buttons carry only a
// label. This plugin prepends our hand-drawn menu icons to them, keyed by that
// label (the package version is pinned, so the labels are stable).
//
// The cell's own `contextmenu` listener stops propagation, so a bubble-phase
// listener on the editor never sees the event. Ours listens in the capture
// phase and decorates on the next animation frame, i.e. after the cell listener
// has opened the menu but before it is painted.

export const TABLE_MENU_ICONS: Record<string, MenuIconName> = {
  'Insert row above': 'rowAbove',
  'Insert row below': 'rowBelow',
  'Delete row': 'rowDelete',
  'Insert column left': 'colLeft',
  'Insert column right': 'colRight',
  'Delete column': 'colDelete',
};

function decorateOpenMenus() {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.cm-atomic-table-menu-item')) {
    if (btn.querySelector('.sunstone-menu-icon')) continue;
    const icon = TABLE_MENU_ICONS[btn.textContent ?? ''];
    if (!icon) continue;
    const slot = document.createElement('span');
    slot.className = 'sunstone-menu-icon';
    slot.innerHTML = menuIconSvg(icon);
    btn.prepend(slot);
    if (icon === 'rowDelete' || icon === 'colDelete') btn.classList.add('danger');
  }
}

export const tableMenuIcons = ViewPlugin.fromClass(
  class {
    private readonly onMenu = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.cm-atomic-table')) {
        requestAnimationFrame(decorateOpenMenus);
      }
    };

    constructor(readonly view: EditorView) {
      view.dom.addEventListener('contextmenu', this.onMenu, true);
    }

    destroy() {
      this.view.dom.removeEventListener('contextmenu', this.onMenu, true);
    }
  },
);
