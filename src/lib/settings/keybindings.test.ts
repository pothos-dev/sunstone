import { describe, expect, test } from 'bun:test';
import {
  chordCaps,
  chordConflicts,
  chordFromEvent,
  COMMANDS,
  commandForEvent,
  DEFAULT_KEYBINDINGS,
  chordLabel,
  eventMatchesChord,
  isRecordableChord,
  normalizeChord,
  resolveKeybindings,
  sameChord,
} from './keybindings';

function keydown(over: Partial<KeyboardEvent>): KeyboardEvent {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: '', code: '', ...over } as KeyboardEvent;
}

describe('normalizeChord', () => {
  test('orders modifiers and lowercases the key', () => {
    expect(normalizeChord('Shift-Mod-F')).toBe('Mod-Shift-f');
    expect(normalizeChord('Alt-Ctrl-ArrowLeft')).toBe('Ctrl-Alt-ArrowLeft');
  });

  test('a trailing dash is the minus key', () => {
    expect(normalizeChord('Mod--')).toBe('Mod--');
    expect(normalizeChord('-')).toBe('-');
  });

  test('printed symbols drop Shift (the character already carries it)', () => {
    expect(normalizeChord('Mod-,')).toBe('Mod-,');
    expect(normalizeChord('Mod-+')).toBe('Mod-+');
    expect(normalizeChord('Mod-Shift-+')).toBe('Mod-+');
    // Digits and letters keep it.
    expect(normalizeChord('Mod-Shift-1')).toBe('Mod-Shift-1');
  });

  test('named keys pass; anything else is refused', () => {
    expect(normalizeChord('F2')).toBe('F2');
    expect(normalizeChord('Mod-Enter')).toBe('Mod-Enter');
    expect(normalizeChord('')).toBeNull();
    expect(normalizeChord('Mod-')).toBeNull();
    expect(normalizeChord('Hyper-k')).toBeNull();
    expect(normalizeChord('Mod-Escape')).toBeNull();
    expect(normalizeChord('Mod-kk')).toBeNull();
  });
});

describe('resolveKeybindings', () => {
  test('defaults when nothing is configured', () => {
    expect(resolveKeybindings(undefined)).toEqual(DEFAULT_KEYBINDINGS);
    expect(DEFAULT_KEYBINDINGS.quickNav).toBe('Mod-k');
    // Paragraph ships unbound (Mod-0 is Reset zoom).
    expect(DEFAULT_KEYBINDINGS.paragraph).toBeNull();
    expect(Object.keys(DEFAULT_KEYBINDINGS)).toHaveLength(COMMANDS.length);
  });

  test('overrides, unbinding with null, normalisation', () => {
    const b = resolveKeybindings({ quickNav: 'shift-mod-P', search: null, paragraph: 'Mod-Alt-0' });
    expect(b.quickNav).toBe('Mod-Shift-p');
    expect(b.search).toBeNull();
    expect(b.paragraph).toBe('Mod-Alt-0');
    expect(b.bold).toBe('Mod-b');
  });

  test('garbage is ignored', () => {
    expect(resolveKeybindings('nope')).toEqual(DEFAULT_KEYBINDINGS);
    expect(resolveKeybindings([1, 2])).toEqual(DEFAULT_KEYBINDINGS);
    const b = resolveKeybindings({ quickNav: 42, bold: 'Mod-Wat', unknownCommand: 'Mod-u' });
    expect(b.quickNav).toBe('Mod-k');
    expect(b.bold).toBe('Mod-b');
    expect('unknownCommand' in b).toBe(false);
  });
});

describe('eventMatchesChord', () => {
  test('Mod accepts Ctrl or Cmd', () => {
    expect(eventMatchesChord(keydown({ ctrlKey: true, key: 'k' }), 'Mod-k')).toBe(true);
    expect(eventMatchesChord(keydown({ metaKey: true, key: 'K' }), 'Mod-k')).toBe(true);
    expect(eventMatchesChord(keydown({ key: 'k' }), 'Mod-k')).toBe(false);
  });

  test('explicit Ctrl wants Ctrl and no Cmd', () => {
    const chord = 'Ctrl-Alt-ArrowLeft';
    expect(eventMatchesChord(keydown({ ctrlKey: true, altKey: true, key: 'ArrowLeft' }), chord)).toBe(true);
    expect(eventMatchesChord(keydown({ metaKey: true, altKey: true, key: 'ArrowLeft' }), chord)).toBe(false);
    expect(
      eventMatchesChord(keydown({ ctrlKey: true, metaKey: true, altKey: true, key: 'ArrowLeft' }), chord),
    ).toBe(false);
  });

  test('Shift and Alt must match exactly for letters', () => {
    expect(eventMatchesChord(keydown({ ctrlKey: true, shiftKey: true, key: 'F' }), 'Mod-Shift-f')).toBe(true);
    expect(eventMatchesChord(keydown({ ctrlKey: true, key: 'f' }), 'Mod-Shift-f')).toBe(false);
    expect(eventMatchesChord(keydown({ ctrlKey: true, shiftKey: true, key: 'F' }), 'Mod-f')).toBe(false);
    expect(eventMatchesChord(keydown({ ctrlKey: true, altKey: true, key: 'f' }), 'Mod-f')).toBe(false);
  });

  test('printed symbols ignore Shift', () => {
    expect(eventMatchesChord(keydown({ ctrlKey: true, shiftKey: true, key: '+' }), 'Mod-+')).toBe(true);
    expect(eventMatchesChord(keydown({ ctrlKey: true, key: ',' }), 'Mod-,')).toBe(true);
    expect(eventMatchesChord(keydown({ ctrlKey: true, key: '-' }), 'Mod--')).toBe(true);
  });

  test('macOS Alt+M arrives as µ and still matches by its physical key', () => {
    const e = keydown({ metaKey: true, altKey: true, key: 'µ', code: 'KeyM' });
    expect(eventMatchesChord(e, 'Mod-Alt-m')).toBe(true);
  });

  test('null never matches', () => {
    expect(eventMatchesChord(keydown({ ctrlKey: true, key: 'k' }), null)).toBe(false);
  });
});

describe('commandForEvent', () => {
  test('finds a command only in its own scope', () => {
    const bold = keydown({ ctrlKey: true, key: 'b' });
    expect(commandForEvent(bold, DEFAULT_KEYBINDINGS, 'editor')).toBe('bold');
    expect(commandForEvent(bold, DEFAULT_KEYBINDINGS, 'app')).toBeNull();
    expect(commandForEvent(keydown({ ctrlKey: true, key: 'k' }), DEFAULT_KEYBINDINGS, 'app')).toBe('quickNav');
  });

  test('nothing fires Paragraph by default', () => {
    expect(commandForEvent(keydown({ ctrlKey: true, key: '0' }), DEFAULT_KEYBINDINGS, 'editor')).toBeNull();
  });
});

describe('chordFromEvent', () => {
  test('non-mac: Ctrl is Mod, Meta stays Meta', () => {
    expect(chordFromEvent(keydown({ ctrlKey: true, shiftKey: true, key: 'K' }), false)).toBe('Mod-Shift-k');
    expect(chordFromEvent(keydown({ metaKey: true, key: 'k' }), false)).toBe('Meta-k');
  });

  test('mac: Cmd is Mod, Ctrl stays Ctrl', () => {
    expect(chordFromEvent(keydown({ metaKey: true, key: 'k' }), true)).toBe('Mod-k');
    expect(chordFromEvent(keydown({ ctrlKey: true, altKey: true, key: 'ArrowLeft' }), true)).toBe('Ctrl-Alt-ArrowLeft');
    expect(chordFromEvent(keydown({ metaKey: true, altKey: true, key: 'µ', code: 'KeyM' }), true)).toBe('Mod-Alt-m');
  });

  test('printed symbols drop Shift; lone modifiers record nothing', () => {
    expect(chordFromEvent(keydown({ ctrlKey: true, shiftKey: true, key: '+' }), false)).toBe('Mod-+');
    expect(chordFromEvent(keydown({ ctrlKey: true, key: 'Control' }), false)).toBeNull();
    expect(chordFromEvent(keydown({ shiftKey: true, key: 'Shift' }), false)).toBeNull();
  });

  test('a recorded chord matches the event it came from', () => {
    for (const e of [
      keydown({ ctrlKey: true, shiftKey: true, key: 'F' }),
      keydown({ ctrlKey: true, key: ',' }),
      keydown({ ctrlKey: true, altKey: true, key: 'ArrowRight' }),
      keydown({ key: 'F2' }),
    ]) {
      expect(eventMatchesChord(e, chordFromEvent(e, false))).toBe(true);
    }
  });
});

describe('chordConflicts', () => {
  test('another command on the same chord', () => {
    const b = resolveKeybindings({ quickNav: 'Mod-b' });
    expect(chordConflicts('Mod-b', 'quickNav', b)).toEqual(['Bold']);
    expect(chordConflicts('Mod-b', 'bold', b)).toEqual(['Quick open']);
  });

  test('fixed shortcuts collide too', () => {
    expect(chordConflicts('Mod-0', 'paragraph', DEFAULT_KEYBINDINGS)).toEqual(['Reset zoom']);
    expect(chordConflicts('Mod-z', 'quickNav', DEFAULT_KEYBINDINGS)).toEqual(['Undo']);
  });

  test('a free chord, and a command against itself', () => {
    expect(chordConflicts('Mod-Alt-0', 'paragraph', DEFAULT_KEYBINDINGS)).toEqual([]);
    expect(chordConflicts('Mod-k', 'quickNav', DEFAULT_KEYBINDINGS)).toEqual([]);
  });
});

describe('chordCaps', () => {
  test('Windows/Linux names', () => {
    expect(chordCaps('Mod-Shift-f', false)).toEqual(['Ctrl', 'Shift', 'F']);
    expect(chordCaps('Ctrl-Alt-ArrowLeft', false)).toEqual(['Ctrl', 'Alt', '←']);
    expect(chordCaps('Mod--', false)).toEqual(['Ctrl', '-']);
  });

  test('macOS glyphs', () => {
    expect(chordCaps('Mod-Shift-f', true)).toEqual(['⌘', '⇧', 'F']);
    expect(chordCaps('Mod-Alt-m', true)).toEqual(['⌘', '⌥', 'M']);
  });
});

describe('editor scope matches Mod strictly', () => {
  test('macOS keeps Ctrl+E and Ctrl+B for the cursor', () => {
    expect(commandForEvent(keydown({ key: 'e', code: 'KeyE', ctrlKey: true }), DEFAULT_KEYBINDINGS, 'editor', true)).toBeNull();
    expect(commandForEvent(keydown({ key: 'b', code: 'KeyB', ctrlKey: true }), DEFAULT_KEYBINDINGS, 'editor', true)).toBeNull();
    expect(commandForEvent(keydown({ key: 'b', code: 'KeyB', metaKey: true }), DEFAULT_KEYBINDINGS, 'editor', true)).toBe('bold');
  });

  test('elsewhere Mod is Ctrl only in the editor', () => {
    expect(commandForEvent(keydown({ key: 'b', code: 'KeyB', ctrlKey: true }), DEFAULT_KEYBINDINGS, 'editor', false)).toBe('bold');
    expect(commandForEvent(keydown({ key: 'b', code: 'KeyB', metaKey: true }), DEFAULT_KEYBINDINGS, 'editor', false)).toBeNull();
  });

  test('app shortcuts still take either key', () => {
    expect(commandForEvent(keydown({ key: 'k', code: 'KeyK', ctrlKey: true }), DEFAULT_KEYBINDINGS, 'app', true)).toBe('quickNav');
    expect(commandForEvent(keydown({ key: 'k', code: 'KeyK', metaKey: true }), DEFAULT_KEYBINDINGS, 'app', false)).toBe('quickNav');
  });
});

describe('AltGr', () => {
  test('an AltGr character is not read as its physical key', () => {
    const altGrM = keydown({
      key: 'µ',
      code: 'KeyM',
      ctrlKey: true,
      altKey: true,
      getModifierState: (k: string) => k === 'AltGraph',
    } as Partial<KeyboardEvent>);
    expect(eventMatchesChord(altGrM, 'Mod-Alt-m')).toBe(false);
    const optionM = keydown({ key: 'µ', code: 'KeyM', metaKey: true, altKey: true, getModifierState: () => false } as Partial<KeyboardEvent>);
    expect(eventMatchesChord(optionM, 'Mod-Alt-m')).toBe(true);
  });
});

describe('sameChord', () => {
  test('off macOS, Ctrl and Mod are the same key', () => {
    expect(sameChord('Mod-Alt-ArrowLeft', 'Ctrl-Alt-ArrowLeft', false)).toBe(true);
    expect(sameChord('Mod-Alt-ArrowLeft', 'Ctrl-Alt-ArrowLeft', true)).toBe(false);
    expect(sameChord('Meta-k', 'Mod-k', true)).toBe(true);
  });

  test('null only equals null', () => {
    expect(sameChord(null, null)).toBe(true);
    expect(sameChord(null, 'Mod-k')).toBe(false);
  });

  test('conflicts see through the spelling', () => {
    const bindings = resolveKeybindings({ bold: 'Ctrl-0' });
    expect(chordConflicts('Ctrl-0', 'bold', bindings, false)).toContain('Reset zoom');
  });
});

describe('isRecordableChord', () => {
  test('needs Ctrl, Cmd or Alt', () => {
    expect(isRecordableChord('Mod-j')).toBe(true);
    expect(isRecordableChord('Alt-j')).toBe(true);
    expect(isRecordableChord('Ctrl-Alt-ArrowLeft')).toBe(true);
    expect(isRecordableChord('j')).toBe(false);
    expect(isRecordableChord('Shift-j')).toBe(false);
    expect(isRecordableChord('Space')).toBe(false);
    expect(isRecordableChord('Enter')).toBe(false);
  });

  test('function keys are fine alone', () => {
    expect(isRecordableChord('F2')).toBe(true);
  });
});

describe('chordLabel', () => {
  test('joins key caps for a tooltip', () => {
    expect(chordLabel('Mod-Shift-f', false)).toBe('Ctrl+Shift+F');
    expect(chordLabel('Mod-Shift-f', true)).toBe('⌘⇧F');
    expect(chordLabel(null, false)).toBe('');
  });
});
