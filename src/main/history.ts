import { randomUUID } from 'node:crypto';
import Store from 'electron-store';
import type { HistoryEntry, Language } from '@shared/types';

/**
 * The dictation log — every transcript, kept so the user can copy one out again.
 *
 * Stored in its own file rather than alongside settings, for two reasons: it's the only
 * thing here that grows without bound, and a corrupt history should never take the user's
 * settings with it.
 *
 * Deliberately NOT encrypted, unlike the Supabase session in auth.json (a refresh token is
 * a credential; a transcript the user dictated is not). The list has to be searchable and
 * rendered a hundred rows at a time, and per-entry safeStorage round-trips would make both
 * slow for no real gain — anything that can read %APPDATA% can also read the process's
 * memory. What protects the user instead is being able to turn the log off entirely
 * (`saveHistory`) and to wipe it, and being told plainly in the UI where the file lives.
 */

/**
 * Entries kept before the oldest are dropped.
 *
 * electron-store rewrites the whole file on every `set`, so this cap is what bounds the
 * cost of a dictation: 500 typical transcripts is ~100 KB, i.e. one trivial write.
 */
const MAX_ENTRIES = 500;

interface HistoryShape {
  /** Newest first — the order the UI wants, so no sorting on read. */
  entries: HistoryEntry[];
}

const store = new Store<HistoryShape>({
  name: 'history',
  defaults: { entries: [] }
});

/**
 * Notified after every mutation so an open app window can re-read the list — including
 * while you dictate into another app. Kept as a plain callback rather than an import of
 * `BrowserWindow` so this module stays a leaf that unit tests can load on its own.
 */
let listener: (() => void) | null = null;

export function onHistoryChanged(cb: () => void): void {
  listener = cb;
}

export function listHistory(): HistoryEntry[] {
  return store.get('entries');
}

export interface NewEntry {
  text: string;
  language: Language;
  durationMs: number;
}

export function addHistory(entry: NewEntry): HistoryEntry {
  const full: HistoryEntry = {
    id: randomUUID(),
    text: entry.text,
    language: entry.language,
    durationMs: Math.round(entry.durationMs),
    createdAt: Date.now()
  };

  store.set('entries', [full, ...listHistory()].slice(0, MAX_ENTRIES));
  listener?.();
  return full;
}

export function removeHistory(id: string): void {
  store.set(
    'entries',
    listHistory().filter((e) => e.id !== id)
  );
  listener?.();
}

export function clearHistory(): void {
  store.set('entries', []);
  listener?.();
}

/** Shown in the UI so the user knows exactly which file to delete if they'd rather. */
export function historyFilePath(): string {
  return store.path;
}

/** Exported for tests. */
export const _internals = { MAX_ENTRIES };
