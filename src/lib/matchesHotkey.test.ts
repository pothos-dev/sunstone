import { describe, expect, test } from 'bun:test';
import { matchesHotkey } from './matchesHotkey';

function keydown(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    key: '',
    ...over,
  } as KeyboardEvent;
}

describe('matchesHotkey', () => {
  test('matches Ctrl+letter with no other modifiers', () => {
    expect(matchesHotkey(keydown({ ctrlKey: true, key: 's' }), { key: 's' })).toBe(true);
  });

  test('matches Cmd (metaKey) interchangeably with Ctrl', () => {
    expect(matchesHotkey(keydown({ metaKey: true, key: 'k' }), { key: 'k' })).toBe(true);
  });

  test('is case-insensitive on the key', () => {
    expect(matchesHotkey(keydown({ ctrlKey: true, key: 'S' }), { key: 's' })).toBe(true);
  });

  test('rejects when neither Ctrl nor Meta is held', () => {
    expect(matchesHotkey(keydown({ key: 's' }), { key: 's' })).toBe(false);
  });

  test('rejects an unexpected Shift when spec requires none', () => {
    expect(
      matchesHotkey(keydown({ ctrlKey: true, shiftKey: true, key: 'k' }), { key: 'k' }),
    ).toBe(false);
  });

  test('requires Shift when the spec asks for it', () => {
    const spec = { key: 'f', shift: true };
    expect(matchesHotkey(keydown({ ctrlKey: true, key: 'f' }), spec)).toBe(false);
    expect(matchesHotkey(keydown({ ctrlKey: true, shiftKey: true, key: 'f' }), spec)).toBe(true);
  });

  test('rejects an unexpected Alt', () => {
    expect(
      matchesHotkey(keydown({ ctrlKey: true, altKey: true, key: 's' }), { key: 's' }),
    ).toBe(false);
  });

  test('rejects a different key', () => {
    expect(matchesHotkey(keydown({ ctrlKey: true, key: 'a' }), { key: 's' })).toBe(false);
  });
});
