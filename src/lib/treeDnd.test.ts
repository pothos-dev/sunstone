import { describe, expect, test } from 'bun:test';
import { canDrop, dropZoneHandlers, type DropZoneEvent } from './treeDnd';

describe('canDrop', () => {
  test('the Bundle root is never draggable', () => {
    expect(canDrop('', 'folder')).toBe(false);
    expect(canDrop('', '')).toBe(false);
  });

  test('rejects a no-op drop into the current parent', () => {
    expect(canDrop('a/b.md', 'a')).toBe(false); // already in `a`
    expect(canDrop('top.md', '')).toBe(false); // already at the root
  });

  test('rejects dropping a folder into itself or a descendant', () => {
    expect(canDrop('a', 'a')).toBe(false);
    expect(canDrop('a', 'a/b')).toBe(false);
    expect(canDrop('a/b', 'a/b/c')).toBe(false);
  });

  test('allows a genuine move into a different folder', () => {
    expect(canDrop('a/b.md', 'c')).toBe(true);
    expect(canDrop('a/b.md', '')).toBe(true); // up to the root
    expect(canDrop('a', 'b')).toBe(true); // sibling folder
    // A folder whose name is a prefix of the target but not a path ancestor.
    expect(canDrop('a', 'ab')).toBe(true);
  });
});

describe('dropZoneHandlers', () => {
  function makeState(dragging: string | null) {
    const state = {
      dragging,
      dropTarget: null as string | null,
      ended: 0,
      end() {
        state.dragging = null;
        state.dropTarget = null;
        state.ended++;
      },
    };
    return state;
  }

  function makeEvent(over: Partial<DropZoneEvent> = {}) {
    const log: string[] = [];
    const e: DropZoneEvent = {
      preventDefault: () => log.push('prevent'),
      stopPropagation: () => log.push('stop'),
      dataTransfer: { dropEffect: 'none' },
      currentTarget: null,
      relatedTarget: null,
      ...over,
    };
    return { e, log };
  }

  test('a legal dragover claims the zone (preventDefault, move effect, highlight)', () => {
    const state = makeState('a/x.md');
    let overs = 0;
    const h = dropZoneHandlers({ state, dir: () => 'b', move: () => {}, onOver: () => overs++ });
    const { e, log } = makeEvent();
    h.ondragover(e);
    expect(log).toEqual(['prevent']);
    expect(e.dataTransfer?.dropEffect).toBe('move');
    expect(state.dropTarget).toBe('b');
    expect(overs).toBe(1);
  });

  test('an illegal or idle dragover leaves the zone unclaimed', () => {
    const idle = makeState(null);
    const h1 = dropZoneHandlers({ state: idle, dir: () => '', move: () => {} });
    const a = makeEvent();
    h1.ondragover(a.e);
    expect(a.log).toEqual([]);
    expect(idle.dropTarget).toBeNull();

    const noop = makeState('top.md'); // already at the root
    const h2 = dropZoneHandlers({ state: noop, dir: () => '', move: () => {} });
    const b = makeEvent();
    h2.ondragover(b.e);
    expect(b.log).toEqual([]);
    expect(noop.dropTarget).toBeNull();
  });

  test('a nested zone stops propagation so the root zone does not also handle it', () => {
    const state = makeState('a/x.md');
    const h = dropZoneHandlers({ state, dir: () => 'b', move: () => {}, nested: true });
    const over = makeEvent();
    h.ondragover(over.e);
    expect(over.log).toEqual(['prevent', 'stop']);
    const drop = makeEvent();
    h.ondrop(drop.e);
    expect(drop.log).toEqual(['prevent', 'stop']);
  });

  test('drop ends the drag and moves only when legal', () => {
    const moves: [string, string][] = [];
    const state = makeState('a/x.md');
    let exits = 0;
    const h = dropZoneHandlers({
      state,
      dir: () => '',
      move: (f, t) => moves.push([f, t]),
      onExit: () => exits++,
    });
    h.ondrop(makeEvent().e);
    expect(moves).toEqual([['a/x.md', '']]);
    expect(state.ended).toBe(1);
    expect(exits).toBe(1);

    const illegal = makeState('a');
    const h2 = dropZoneHandlers({ state: illegal, dir: () => 'a/b', move: (f, t) => moves.push([f, t]) });
    h2.ondrop(makeEvent().e);
    expect(moves).toHaveLength(1);
    expect(illegal.ended).toBe(1);
  });

  test('dragleave clears only its own highlight, and ignores leaves into descendants', () => {
    const state = makeState('a/x.md');
    state.dropTarget = 'b';
    let exits = 0;
    const h = dropZoneHandlers({ state, dir: () => 'b', move: () => {}, onExit: () => exits++ });
    const child = {} as EventTarget;
    const zone = { contains: (n: unknown) => n === child } as unknown as EventTarget;
    h.ondragleave(makeEvent({ currentTarget: zone, relatedTarget: child }).e);
    expect(state.dropTarget).toBe('b');
    expect(exits).toBe(0);

    h.ondragleave(makeEvent({ currentTarget: zone, relatedTarget: null }).e);
    expect(state.dropTarget).toBeNull();
    expect(exits).toBe(1);

    state.dropTarget = 'elsewhere';
    h.ondragleave(makeEvent({ currentTarget: zone, relatedTarget: null }).e);
    expect(state.dropTarget).toBe('elsewhere');
  });
});
