import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * uiohook-napi is a native module and a global keyboard hook; neither belongs in a unit
 * test. What is worth testing is the state machine on top of it — which is now the part
 * that reads the user's own chords, and the part where "one chord is a prefix of the other"
 * turns into a dictation that toggles itself straight back off.
 */
const listeners = new Map<string, ((e: { keycode: number }) => void)[]>();

vi.mock('uiohook-napi', async () => {
  const actual = await vi.importActual<typeof import('uiohook-napi')>('uiohook-napi');
  return {
    UiohookKey: actual.UiohookKey,
    uIOhook: {
      on(event: string, cb: (e: { keycode: number }) => void) {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
      },
      start() {},
      stop() {}
    }
  };
});

const { hotkey } = await import('./hotkey');
const { UiohookKey } = await import('uiohook-napi');

/** Which physical key each canonical name is pressed as, for the tests below. */
const CODE: Record<string, number> = {
  Ctrl: UiohookKey.Ctrl,
  Shift: UiohookKey.Shift,
  Alt: UiohookKey.Alt,
  Win: UiohookKey.Meta,
  Space: UiohookKey.Space,
  V: UiohookKey.V,
  Escape: UiohookKey.Escape
};

function fire(event: 'keydown' | 'keyup', name: string): void {
  for (const cb of listeners.get(event) ?? []) cb({ keycode: CODE[name] });
}

const down = (...names: string[]) => names.forEach((n) => fire('keydown', n));
const up = (...names: string[]) => names.forEach((n) => fire('keyup', n));

let events: string[] = [];

hotkey.start();
hotkey.on('start', () => events.push('start'));
hotkey.on('stop', () => events.push('stop'));
hotkey.on('cancel', () => events.push('cancel'));
hotkey.on('toggle', () => events.push('toggle'));

beforeEach(() => {
  events = [];
  hotkey.setChords({ pushToTalk: ['Ctrl', 'Shift'], handsFree: [] });
});

describe('push to talk', () => {
  it('starts when the whole chord is down and stops when any of it leaves', () => {
    down('Ctrl', 'Shift');
    expect(events).toEqual(['start']);
    up('Shift');
    expect(events).toEqual(['start', 'stop']);
  });

  it('does not start on half a chord', () => {
    down('Ctrl');
    expect(events).toEqual([]);
  });

  it('survives auto-repeat: one physical press is one start', () => {
    down('Ctrl', 'Shift');
    down('Ctrl', 'Shift', 'Ctrl', 'Shift');
    expect(events).toEqual(['start']);
  });

  it('cancels when a key outside the chord joins in — that is a shortcut, not speech', () => {
    down('Ctrl', 'Shift');
    down('V');
    expect(events).toEqual(['start', 'cancel']);
  });

  it('matches whatever the user bound, not Ctrl+Shift', () => {
    hotkey.setChords({ pushToTalk: ['Alt', 'Win'], handsFree: [] });
    down('Ctrl', 'Shift');
    expect(events).toEqual([]);
    down('Alt', 'Win');
    expect(events).toEqual(['start']);
    up('Alt');
    expect(events).toEqual(['start', 'stop']);
  });

  it('takes a chord ending in an ordinary key', () => {
    hotkey.setChords({ pushToTalk: ['Ctrl', 'Space'], handsFree: [] });
    down('Ctrl', 'Space');
    expect(events).toEqual(['start']);
    up('Space');
    expect(events).toEqual(['start', 'stop']);
  });

  it('cancels on Esc, and reports the Esc even with nothing running', () => {
    down('Ctrl', 'Shift');
    down('Escape');
    expect(events).toEqual(['start', 'cancel']);
    up('Ctrl', 'Shift');

    events = [];
    down('Escape');
    expect(events).toEqual(['cancel']);
  });
});

describe('hands-free', () => {
  it('is off until a chord is bound', () => {
    down('Ctrl', 'Alt');
    up('Ctrl', 'Alt');
    expect(events).toEqual([]);
  });

  it('fires once per press, not once per auto-repeat', () => {
    hotkey.setChords({ pushToTalk: ['Ctrl', 'Shift'], handsFree: ['Ctrl', 'Alt'] });
    down('Ctrl', 'Alt');
    down('Ctrl', 'Alt', 'Ctrl');
    expect(events).toEqual(['toggle']);
  });

  it('re-arms after the keys come up', () => {
    hotkey.setChords({ pushToTalk: ['Ctrl', 'Shift'], handsFree: ['Ctrl', 'Alt'] });
    down('Ctrl', 'Alt');
    up('Ctrl', 'Alt');
    down('Ctrl', 'Alt');
    expect(events).toEqual(['toggle', 'toggle']);
  });

  it('ends a push-to-talk gesture rather than layering a dictation on top of it', () => {
    hotkey.setChords({ pushToTalk: ['Ctrl', 'Shift'], handsFree: ['Ctrl', 'Shift', 'Space'] });
    down('Ctrl', 'Shift');
    expect(events).toEqual(['start']);
    down('Space');
    expect(events).toEqual(['start', 'cancel', 'toggle']);
  });

  /**
   * The bug this file exists for.
   *
   * A hands-free dictation ends in `reset()`, which calls `resetModifierState()` — emptying
   * the hook's copy of the keyboard while the user's fingers are still on the keys. Every
   * key auto-repeats, so the shorter chord is satisfied again a few milliseconds later, and
   * with the latch cleared the toggle fires a second time and stops the dictation that had
   * just started.
   */
  it('does not fire twice when the state machine resets under held keys', () => {
    hotkey.setChords({ pushToTalk: ['Ctrl', 'Shift'], handsFree: ['Ctrl', 'Shift', 'Space'] });
    down('Ctrl', 'Shift', 'Space');
    expect(events).toEqual(['start', 'cancel', 'toggle']);

    // What state.ts does on its way back to IDLE, while nothing has been released.
    hotkey.resetModifierState();
    events = [];

    // Auto-repeat, with the same three keys still physically down.
    down('Ctrl', 'Shift', 'Space');
    expect(events).toEqual([]);
  });

  it('and comes back the moment a key is actually released', () => {
    hotkey.setChords({ pushToTalk: ['Ctrl', 'Shift'], handsFree: ['Ctrl', 'Shift', 'Space'] });
    down('Ctrl', 'Shift', 'Space');
    hotkey.resetModifierState();
    events = [];

    up('Space', 'Ctrl', 'Shift');
    down('Ctrl', 'Shift', 'Space');
    expect(events).toEqual(['start', 'cancel', 'toggle']);
  });
});

describe('watch', () => {
  it('reports only the keys of the chord it was handed', () => {
    const seen: string[][] = [];
    hotkey.on('keys', (keys) => seen.push(keys));
    hotkey.watch(['Ctrl', 'Shift']);

    down('Ctrl');
    down('Alt');
    expect(seen.at(-1)).toEqual(['Ctrl']);

    down('Shift');
    expect(seen.at(-1)).toEqual(['Ctrl', 'Shift']);

    up('Ctrl');
    expect(seen.at(-1)).toEqual(['Shift']);
  });

  it('says nothing at all once the watch is dropped', () => {
    hotkey.watch(['Ctrl', 'Shift']);
    const seen: string[][] = [];
    hotkey.on('keys', (keys) => seen.push(keys));
    hotkey.watch([]);
    seen.length = 0;

    down('Ctrl', 'Shift');
    expect(seen).toEqual([]);
  });
});
