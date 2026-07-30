// Pure keydown-vs-hotkey-spec matcher, shared by the web viewer's global
// keydown handlers (`WebViewer.svelte`, `WebAppShellIsland.svelte`) so the
// Ctrl/Cmd-plus-modifiers parsing lives in one tested place instead of being
// duplicated inline in each `onKeydown`.

/** A hotkey spec: `key` is matched case-insensitively; `Ctrl` (or `Cmd` on
 *  mac) is always required. `shift`/`alt` default to `false` (i.e. the
 *  modifier must be UP unless explicitly required). */
export interface HotkeySpec {
  key: string;
  shift?: boolean;
  alt?: boolean;
}

/** Does this keydown event match `spec`? Ctrl or Meta (Cmd) satisfies the
 *  "primary modifier" requirement interchangeably (cross-platform). Shift/Alt
 *  must match exactly (present iff the spec asks for it). */
export function matchesHotkey(e: KeyboardEvent, spec: HotkeySpec): boolean {
  const wantShift = spec.shift ?? false;
  const wantAlt = spec.alt ?? false;
  return (
    (e.ctrlKey || e.metaKey) &&
    e.shiftKey === wantShift &&
    e.altKey === wantAlt &&
    e.key.toLowerCase() === spec.key.toLowerCase()
  );
}
