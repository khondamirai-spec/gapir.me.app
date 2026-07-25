import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * electron-store is replaced with an in-memory equivalent: what's worth testing here is the
 * newest-first ordering and the cap that keeps a dictation's write cheap, not whether
 * electron-store can write JSON.
 */
vi.mock('electron-store', () => {
  return {
    default: class FakeStore {
      private data: Record<string, unknown>;
      readonly path = 'C:\\fake\\history.json';

      constructor(options: { defaults: Record<string, unknown> }) {
        this.data = { ...options.defaults };
      }

      get(key: string): unknown {
        return this.data[key];
      }

      set(key: string, value: unknown): void {
        this.data[key] = value;
      }
    }
  };
});

const {
  addHistory,
  listHistory,
  removeHistory,
  clearHistory,
  onHistoryChanged,
  historyFilePath,
  _internals
} = await import('./history');

const entry = (text: string) => ({ text, language: 'uz' as const, durationMs: 1234 });

describe('history', () => {
  beforeEach(() => {
    clearHistory();
    onHistoryChanged(() => {});
  });

  it('returns the newest entry first', () => {
    addHistory(entry('birinchi'));
    addHistory(entry('ikkinchi'));

    expect(listHistory().map((e) => e.text)).toEqual(['ikkinchi', 'birinchi']);
  });

  it('stamps each entry with a unique id and a timestamp', () => {
    const a = addHistory(entry('bir'));
    const b = addHistory(entry('ikki'));

    expect(a.id).not.toBe(b.id);
    expect(a.createdAt).toBeGreaterThan(0);
    expect(a.durationMs).toBe(1234);
  });

  it('drops the oldest entries once the cap is reached', () => {
    for (let i = 0; i < _internals.MAX_ENTRIES + 10; i++) addHistory(entry(`yozuv ${i}`));

    const all = listHistory();
    expect(all).toHaveLength(_internals.MAX_ENTRIES);
    // Newest kept, oldest gone.
    expect(all[0].text).toBe(`yozuv ${_internals.MAX_ENTRIES + 9}`);
    expect(all.some((e) => e.text === 'yozuv 0')).toBe(false);
  });

  it('rounds fractional durations — they come from a byte count, not a clock', () => {
    const saved = addHistory({ text: 'x', language: 'uz', durationMs: 1899.6666 });
    expect(saved.durationMs).toBe(1900);
  });

  it('removes only the requested entry', () => {
    const keep = addHistory(entry('qoladi'));
    const drop = addHistory(entry('o‘chadi'));

    removeHistory(drop.id);

    expect(listHistory().map((e) => e.id)).toEqual([keep.id]);
  });

  it('ignores a delete for an id that is not there', () => {
    addHistory(entry('bor'));
    removeHistory('yo‘q-id');
    expect(listHistory()).toHaveLength(1);
  });

  it('notifies the listener on every mutation, so an open window stays in step', () => {
    const seen = vi.fn();
    onHistoryChanged(seen);

    const added = addHistory(entry('bir'));
    removeHistory(added.id);
    clearHistory();

    expect(seen).toHaveBeenCalledTimes(3);
  });

  it('exposes the file path, because the UI tells the user where their speech lives', () => {
    expect(historyFilePath()).toMatch(/history\.json$/);
  });
});
