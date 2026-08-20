// The brand faces. Imported from the entry rather than <link>ed from the HTML so that Vite
// emits the .woff2 files and rewrites their URLs for both the dev server and file://.
import '../fonts/fonts.css';
import type {
  AccountState,
  AppSection,
  HistoryEntry,
  Language,
  Settings,
  StyleSettings,
  UpdateStatus
} from '../../shared/types';
import {
  chordEquals,
  chordProblem,
  DEFAULT_HOTKEYS,
  formatChord,
  keyLabel,
  keyNameFromCode,
  pushToTalkWarning,
  sortChord,
  type Chord,
  type HotkeySettings
} from '../../shared/hotkeys';
import { countWords, wordsPerMinute, WORD_CHARS } from '../../shared/text';

/**
 * The app window: history, statistics, style, notes and settings.
 *
 * Plain DOM on purpose — main owns every piece of state that matters, and this file reads
 * it, draws it, and asks main to change it. A framework here would add a build step and a
 * mental model without removing a single line of the work below.
 *
 * Two rules worth keeping while editing:
 *  - anything the user typed goes in with `textContent`, never `innerHTML`. Transcripts are
 *    arbitrary text and this window renders hundreds of them.
 *  - `settings` below is a cache of what main last told us. Change it through `patch()`,
 *    never by assignment, so the two can't drift.
 */

function el<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as unknown as T;
}

/** Our cache of main's settings. Never written directly — see `patch()`. */
let settings: Settings;
let entries: HistoryEntry[] = [];

/**
 * Our cache of the account, as main last described it.
 *
 * Declared up here with the other two rather than beside the Hisob pane it mostly serves,
 * because the Statistika pane reads it too (the weekly allowance) and `let` has a temporal
 * dead zone: a call ordered even slightly differently — a renderer reload, a section opened
 * straight from the tray — would throw on a variable that had not been reached yet, which is
 * a nasty way to learn about module evaluation order. The initialiser is the signed-out
 * state, which is also the truth until main says otherwise.
 */
let account: AccountState = { user: null, plan: null, error: '' };

async function patch(change: Partial<Settings>): Promise<boolean> {
  const result = await window.api.setSettings(change);
  if (!result.ok) {
    toast(result.error ?? 'Saqlab bo‘lmadi');
    return false;
  }
  settings = { ...settings, ...change };
  return true;
}

// ------------------------------------------------------------------- toast

const toastEl = el<HTMLElement>('toast');
let toastTimer: number | undefined;

function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add('on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('on'), 1800);
}

function setMsg(target: HTMLElement, text: string, kind: '' | 'ok' | 'warn' | 'err' = ''): void {
  target.textContent = text;
  target.className = kind ? `msg ${kind}` : 'msg';
}

// ------------------------------------------------------------------- icons

/**
 * Inline SVG, because the window's CSP is `default-src 'self'` and an icon font would be a
 * network request that never resolves. Written as markup rather than as DOM calls purely
 * for legibility; every string here is a constant in this file, never user input.
 */
const ICONS: Record<string, string> = {
  mic: '<path d="M12 3.5a2.6 2.6 0 0 1 2.6 2.6v5a2.6 2.6 0 1 1-5.2 0v-5A2.6 2.6 0 0 1 12 3.5z"/><path d="M5.8 11a6.2 6.2 0 0 0 12.4 0"/><path d="M12 17.2V21"/>',
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  style: '<path d="M4 6h10"/><path d="M9 6v13"/><path d="M14.5 12h5.5"/><path d="M17.2 12v7"/>',
  note: '<path d="M5 3.5h9.5L19 8v12.5H5z"/><path d="M14 3.5V8h5"/><path d="M8.5 13h7"/><path d="M8.5 16.5h4.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.5"/><path d="M12 17.2h.01"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
  pencil:
    '<path d="M4 20h4.2l9.6-9.6a2.4 2.4 0 0 0 0-3.4l-.8-.8a2.4 2.4 0 0 0-3.4 0L4 15.8z"/><path d="M13.4 6.6l4 4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-6A3.5 3.5 0 0 0 3 6.5v6A2.5 2.5 0 0 0 5.5 15"/>',
  trash:
    '<path d="M4.5 6.5h15"/><path d="M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7"/><path d="M6.5 6.5 7.4 20a1.3 1.3 0 0 0 1.3 1.2h6.6a1.3 1.3 0 0 0 1.3-1.2l.9-13.5"/>',
  // The four times of day, for the Statistika rhythm rows.
  sunrise:
    '<path d="M12 2.8v4.4"/><path d="M9.3 5.5 12 2.8l2.7 2.7"/><path d="M5.3 9.6 4 8.3M18.7 9.6 20 8.3"/><path d="M7 16a5 5 0 0 1 10 0"/><path d="M2.5 20h19"/><path d="M2.5 16H4.2M19.8 16h1.7"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.3M12 19.2v2.3M4.4 4.4 6 6M18 18l1.6 1.6M2.5 12h2.3M19.2 12h2.3M4.4 19.6 6 18M18 6l1.6-1.6"/>',
  sunset:
    '<path d="M12 7.2V2.8"/><path d="M9.3 4.5 12 7.2l2.7-2.7"/><path d="M5.3 9.6 4 8.3M18.7 9.6 20 8.3"/><path d="M7 16a5 5 0 0 1 10 0"/><path d="M2.5 20h19"/><path d="M2.5 16H4.2M19.8 16h1.7"/>',
  moon: '<path d="M20 14.4A8.6 8.6 0 0 1 9.6 4 8.6 8.6 0 1 0 20 14.4z"/>'
};

function icon(name: string, size = 16): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

/** A small round icon button, used in list rows. */
function iconButton(name: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'icon-btn';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = icon(name, 15);
  button.addEventListener('click', onClick);
  return button;
}

// ------------------------------------------------------------- level meter

const METER_BARS = 16;

interface Meter {
  set(level: number): void;
  reset(): void;
}

function createMeter(container: HTMLElement): Meter {
  const bars: HTMLElement[] = [];
  for (let i = 0; i < METER_BARS; i++) {
    const bar = document.createElement('i');
    container.appendChild(bar);
    bars.push(bar);
  }

  let smoothed = 0;
  return {
    set(level: number): void {
      // Same asymmetric smoothing as the overlay pill: fast attack, slow release.
      smoothed += (level - smoothed) * (level > smoothed ? 0.55 : 0.15);
      // sqrt, because raw RMS of ordinary speech barely leaves the floor.
      const lit = Math.round(Math.sqrt(smoothed) * METER_BARS * 1.35);
      bars.forEach((bar, i) => {
        const on = i < lit;
        bar.classList.toggle('lit', on);
        bar.style.height = `${on ? 5 + (i / METER_BARS) * 20 : 3}px`;
      });
    },
    reset(): void {
      smoothed = 0;
      bars.forEach((bar) => {
        bar.classList.remove('lit');
        bar.style.height = '3px';
      });
    }
  };
}

/**
 * Only one process can hold a microphone, so only one test runs at a time — whichever view
 * asked last wins, and the loser's button is put back.
 */
const micTest = {
  active: null as { button: HTMLButtonElement | null; meter: Meter; msg: HTMLElement } | null,

  /**
   * Open the microphone and feed `meter`.
   *
   * `button` is optional because the welcome flow has none: its microphone step runs the
   * test the moment it is opened, which is the whole answer to "is this the right mic?" —
   * asking someone to press Tekshirish first only adds a step between the question and its
   * answer. Sozlamalar still passes one, because there the test is a thing you ask for.
   */
  async start(
    deviceId: string,
    meter: Meter,
    button: HTMLButtonElement | null,
    msg: HTMLElement
  ): Promise<void> {
    await this.stop();
    setMsg(msg, '');
    this.active = { button, meter, msg };
    if (button) button.textContent = 'To‘xtatish';
    await window.api.startMicTest(deviceId);
  },

  async toggle(
    deviceId: string,
    meter: Meter,
    button: HTMLButtonElement,
    msg: HTMLElement
  ): Promise<void> {
    const wasMine = this.active?.button === button;
    await this.stop();
    if (wasMine) return;
    await this.start(deviceId, meter, button, msg);
  },

  async stop(): Promise<void> {
    if (!this.active) return;
    if (this.active.button) this.active.button.textContent = 'Tekshirish';
    this.active.meter.reset();
    this.active = null;
    await window.api.stopMicTest();
  }
};

window.api.onMicLevel((level) => micTest.active?.meter.set(level));

// A failed test belongs to whichever view opened the microphone, and the record carries its
// own message element so this does not have to guess from the button — the welcome flow's
// test has no button at all.
window.api.onMicError((message) => {
  const target = micTest.active?.msg;
  void micTest.stop();
  if (target) setMsg(target, message, 'err');
});

async function fillDevices(select: HTMLSelectElement, selectedId: string): Promise<number> {
  const devices = await window.api.listDevices();
  // Rebuild rather than append: the list is re-read every time the window opens, and
  // devices come and go with headsets.
  select.length = 1;
  for (const device of devices) {
    const option = document.createElement('option');
    // Show the friendly name, but store the ASCII alternative name ffmpeg needs.
    option.value = device.id;
    option.textContent = device.label;
    select.appendChild(option);
  }
  select.value = selectedId;
  return devices.length;
}

// ------------------------------------------------------------- window chrome

el<HTMLButtonElement>('winMin').addEventListener('click', () => void window.api.minimizeWindow());
el<HTMLButtonElement>('winClose').addEventListener('click', () => void window.api.closeWindow());

const winMaxEl = el<HTMLButtonElement>('winMax');
winMaxEl.addEventListener('click', async () =>
  setMaximized(await window.api.toggleMaximizeWindow())
);

/** The restore glyph is two offset rectangles; the maximise one is a single square. */
function setMaximized(maximized: boolean): void {
  winMaxEl.innerHTML = maximized
    ? '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="1.5" y="3.5" width="7" height="7" rx="1"/><path d="M3.8 3.5v-2h6.7v6.7h-2"/></svg>'
    : '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/></svg>';
  winMaxEl.title = maximized ? 'Oldingi holatga' : 'Kattalashtirish';
}

window.api.onWindowState(setMaximized);

el<HTMLButtonElement>('toggleSidebar').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-collapsed');
});

el<HTMLButtonElement>('openSettingsTop').addEventListener('click', () => void show('settings'));

// -------------------------------------------------------------- navigation

interface NavEntry {
  section: AppSection;
  label: string;
  icon: string;
}

const NAV: NavEntry[] = [
  { section: 'dictation', label: 'Diktovka', icon: 'mic' },
  { section: 'insights', label: 'Statistika', icon: 'chart' },
  { section: 'style', label: 'Uslub', icon: 'style' },
  { section: 'scratchpad', label: 'Qaydlar', icon: 'note' }
];

const NAV_BOTTOM: NavEntry[] = [
  { section: 'account', label: 'Hisob', icon: 'user' },
  { section: 'settings', label: 'Sozlamalar', icon: 'gear' },
  { section: 'help', label: 'Yordam', icon: 'help' }
];

const navEl = el<HTMLElement>('nav');
const navBottomEl = el<HTMLElement>('navBottom');

function renderNav(container: HTMLElement, items: NavEntry[]): void {
  container.replaceChildren();
  for (const item of items) {
    const button = document.createElement('button');
    button.className = 'nav-item';
    button.dataset.section = item.section;
    button.innerHTML = `${icon(item.icon)}<span>${item.label}</span>`;
    button.addEventListener('click', () => void show(item.section));
    container.appendChild(button);
  }
}

renderNav(navEl, NAV);
renderNav(navBottomEl, NAV_BOTTOM);

const views = new Map<AppSection, HTMLElement>();
for (const view of document.querySelectorAll<HTMLElement>('.view')) {
  views.set(view.dataset.view as AppSection, view);
}

/**
 * Show a section.
 *
 * `settings` is the odd one out and deliberately so: it is a modal over whatever you were
 * reading, not a pane you navigate to, so it opens on top and the pane underneath is left
 * exactly where it was. Everything else routes normally.
 */
async function show(section: AppSection): Promise<void> {
  if (section === 'settings') {
    await openSettings();
    return;
  }

  // The microphone must not stay open on a screen the user has navigated away from.
  await micTest.stop();

  for (const [name, view] of views) view.classList.toggle('on', name === section);
  for (const button of document.querySelectorAll<HTMLElement>('.nav-item')) {
    button.classList.toggle('on', button.dataset.section === section);
  }

  // Panes that read something main owns re-read it on entry; nothing here caches across
  // navigations except the settings object itself.
  if (section === 'dictation' || section === 'insights') await loadHistory();
  if (section === 'style') renderStyle();
  if (section === 'scratchpad')
    el<HTMLTextAreaElement>('scratchpadText').value = settings.scratchpad;
  if (section === 'account') {
    // Draw what we already know first, then correct it: today's count changes with every
    // dictation, including ones made while this window was closed, so the cached number is
    // right often enough to show immediately and wrong often enough to always re-ask.
    renderAccount();
    await window.api.refreshPlan();
  }
}

function isSection(name: string): name is AppSection {
  return views.has(name as AppSection) || name === 'settings';
}

window.api.onRoute((section) => {
  if (isSection(section)) void show(section);
});

function requestedSection(): AppSection {
  const hash = window.location.hash.replace('#', '');
  return isSection(hash) ? hash : 'dictation';
}

// ---------------------------------------------------------------- history

const searchEl = el<HTMLInputElement>('search');
const searchWrapEl = el<HTMLElement>('searchWrap');
const entriesEl = el<HTMLElement>('entries');
const greetingEl = el<HTMLElement>('greeting');

/** Ids the user has clicked open; kept across re-renders so a new dictation doesn't collapse them. */
const expanded = new Set<string>();

const DAY_MS = 86_400_000;

function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Uzbek month and weekday names, written out here rather than asked for.
 *
 * **`toLocaleDateString('uz-UZ', { month: 'long' })` does not return Uzbek.** Chromium's ICU
 * has no calendar data for this locale and falls back to the root one, which renders August
 * as `M08` and Monday as `Mon.` — the Statistika pane shipped a line reading
 * "keyingisi M08 24, Mon." before anyone looked at it. Every user-facing string in this app
 * is Uzbek by rule (see the Conventions section of CLAUDE.md), and a locale that answers in
 * month codes cannot honour that rule, so the names are ours.
 *
 * Indexed by `Date#getMonth()` and `Date#getDay()` respectively, which is why the weekday
 * list starts on Sunday even though the app's week starts on Monday. Read through them;
 * never slice them. See HEAT_ROWS for the display order.
 */
const MONTH_NAMES = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr'
];

const WEEKDAY_NAMES = [
  'yakshanba',
  'dushanba',
  'seshanba',
  'chorshanba',
  'payshanba',
  'juma',
  'shanba'
];

/** "24-avgust" — how a date is written in Uzbek, with the day fused to the month. */
function formatDayMonth(ts: number, withYear = false): string {
  const date = new Date(ts);
  const base = `${date.getDate()}-${MONTH_NAMES[date.getMonth()]}`;
  return withYear ? `${base} ${date.getFullYear()}` : base;
}

/** "24.08.2026" — the numeric form, for tooltips where a sentence would be too long. */
function formatDateNumeric(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/**
 * A count with its thousands grouped: 1000 -> "1 000".
 *
 * Separate from `formatCount`, which abbreviates to "1.0K" and is right for a headline
 * figure nobody does arithmetic on. It is wrong for anything the user is meant to measure
 * themselves against — a weekly allowance drawn as "0 / 1.0K so'z" reads like a rounded
 * estimate of a rule that is in fact exact.
 *
 * A non-breaking space, so the number never wraps across the gap it was grouped by.
 */
function formatNumber(value: number): string {
  return value.toLocaleString('ru-RU').replace(/\s/g, '\u00a0');
}

/** BUGUN / KECHA / a date — the same three-way split the eye makes when scanning a log. */
function dayLabel(ts: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day === today) return 'Bugun';
  if (day === today - DAY_MS) return 'Kecha';
  return formatDayMonth(ts, day < today - 300 * DAY_MS);
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString('uz-UZ', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function renderHistory(): void {
  const query = searchEl.value.trim().toLowerCase();
  const visible = query
    ? entries.filter((entry) => entry.text.toLowerCase().includes(query))
    : entries;

  entriesEl.replaceChildren();

  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    if (query) {
      empty.textContent = 'Bunday matn topilmadi.';
    } else {
      empty.innerHTML =
        '<span class="big">Hali hech narsa aytilmagan</span>' +
        `Xohlagan dasturda ${hotkeyCaps()} ni bosib turib gapiring.<br />` +
        'Aytganingiz shu yerda paydo bo‘ladi.';
    }
    entriesEl.appendChild(empty);
    return;
  }

  let lastDay = '';
  visible.forEach((entry, index) => {
    const label = dayLabel(entry.createdAt);
    if (label !== lastDay) {
      lastDay = label;
      const head = document.createElement('div');
      head.className = 'group-head';
      head.textContent = label;
      entriesEl.appendChild(head);
    }
    entriesEl.appendChild(renderEntry(entry, index));
  });
}

function renderEntry(entry: HistoryEntry, index: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'entry';
  // Stagger the rows in, but only the first screenful: past that the delay would be a
  // list that visibly takes a second to appear.
  row.style.animationDelay = `${Math.min(index, 10) * 22}ms`;

  const when = document.createElement('div');
  when.className = 'when';
  when.textContent = timeLabel(entry.createdAt);
  when.title = `${(entry.durationMs / 1000).toFixed(1)} s · ${countWords(entry.text)} so‘z`;

  const body = document.createElement('div');
  body.style.flex = '1';
  body.style.minWidth = '0';

  const text = document.createElement('div');
  text.className = expanded.has(entry.id) ? 'text' : 'text clamped';
  text.textContent = entry.text;
  body.appendChild(text);

  // Only offer the toggle when there is something hidden: `scrollHeight` is only truthful
  // after layout, so this runs on the next frame rather than during construction.
  requestAnimationFrame(() => {
    if (text.scrollHeight <= text.clientHeight + 2 && !expanded.has(entry.id)) return;
    const more = document.createElement('button');
    more.className = 'more';
    const sync = (): void => {
      more.textContent = expanded.has(entry.id) ? 'Yig‘ish' : 'To‘liq ko‘rsatish';
    };
    sync();
    more.addEventListener('click', () => {
      if (expanded.has(entry.id)) expanded.delete(entry.id);
      else expanded.add(entry.id);
      text.classList.toggle('clamped');
      sync();
    });
    body.appendChild(more);
  });

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    iconButton('copy', 'Nusxa olish', () => {
      void window.api.copyText(entry.text);
      toast('Nusxalandi');
    }),
    iconButton('trash', 'O‘chirish', () => void window.api.deleteHistory(entry.id))
  );

  row.append(when, body, actions);
  return row;
}

async function loadHistory(): Promise<void> {
  const { entries: list, filePath } = await window.api.listHistory();
  entries = list;
  el<HTMLElement>('historyPath').textContent = filePath;
  el<HTMLElement>('helpPath').textContent = filePath;
  renderHistory();
  renderRail();
  renderInsights();
}

searchEl.addEventListener('input', renderHistory);
searchEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  searchEl.value = '';
  searchWrapEl.classList.remove('open');
  renderHistory();
});
searchEl.addEventListener('blur', () => {
  if (!searchEl.value) searchWrapEl.classList.remove('open');
});

el<HTMLButtonElement>('searchBtn').addEventListener('click', () => {
  searchWrapEl.classList.toggle('open');
  if (searchWrapEl.classList.contains('open')) searchEl.focus();
  else if (searchEl.value) {
    searchEl.value = '';
    renderHistory();
  }
});

// Main tells us whenever the log changes — including from a dictation happening right now,
// into this very window's notes pane.
window.api.onHistoryChanged(() => void loadHistory());

// ------------------------------------------------------------------ stats

interface Stats {
  dictations: number;
  words: number;
  wpm: number;
  /** Fastest single dictation, ignoring clips too short to mean anything. */
  bestWpm: number;
  streak: number;
  /** The last day of the current streak, or 0 when there is no streak. */
  streakEnd: number;
  longestStreak: number;
  seconds: number;
  longestMs: number;
  /** Days that saw at least one dictation. */
  activeDays: number;
  /** Words per calendar day, keyed by `startOfDay` — the chart and the heat map both read it. */
  byDay: Map<number, number>;
}

/**
 * A dictation this short is not a speaking rate, it is a rounding error: two words in
 * 700ms is 170 words a minute, and one of those at the top of a "fastest" figure would
 * make the honest number underneath it look wrong.
 */
const MIN_RATED_MS = 2500;

/**
 * Everything the Insights pane and the sidebar rail show, from the history log alone.
 *
 * The streak counts backwards from today, and tolerates today being empty: at 9am nobody
 * has dictated yet, and telling them their streak is over would be both wrong and rude.
 */
function computeStats(list: HistoryEntry[]): Stats {
  let words = 0;
  let ms = 0;
  let bestWpm = 0;
  let longestMs = 0;
  const byDay = new Map<number, number>();

  for (const entry of list) {
    const count = countWords(entry.text);
    words += count;
    ms += entry.durationMs;
    if (entry.durationMs > longestMs) longestMs = entry.durationMs;
    if (entry.durationMs >= MIN_RATED_MS) {
      bestWpm = Math.max(bestWpm, wordsPerMinute(entry.text, entry.durationMs));
    }
    const day = startOfDay(entry.createdAt);
    byDay.set(day, (byDay.get(day) ?? 0) + count);
  }

  const days = new Set(list.map((entry) => startOfDay(entry.createdAt)));
  const today = startOfDay(Date.now());
  let streak = 0;
  let cursor = days.has(today) ? today : today - DAY_MS;
  const streakEnd = days.has(cursor) ? cursor : 0;
  while (days.has(cursor)) {
    streak++;
    cursor -= DAY_MS;
  }

  // The best run ever, over the sorted days: a gap of more than one day ends a run.
  const sorted = [...days].sort((a, b) => a - b);
  let longestStreak = 0;
  let run = 0;
  sorted.forEach((day, index) => {
    run = index > 0 && day - sorted[index - 1] === DAY_MS ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
  });

  return {
    dictations: list.length,
    words,
    wpm: ms > 0 ? Math.round(words / (ms / 60_000)) : 0,
    bestWpm,
    streak,
    streakEnd,
    longestStreak,
    seconds: Math.round(ms / 1000),
    longestMs,
    activeDays: days.size,
    byDay
  };
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} daq`;
  const hours = Math.floor(seconds / 3600);
  return `${hours} soat ${Math.round((seconds % 3600) / 60)} daq`;
}

const railStatsEl = el<HTMLElement>('railStats');

function renderRail(): void {
  const stats = computeStats(entries);
  railStatsEl.replaceChildren();
  const rows: Array<[string, string]> = [
    [formatCount(stats.words), 'jami so‘z'],
    [String(stats.wpm), 'so‘z/daqiqa'],
    [String(stats.streak), 'kun ketma-ket']
  ];
  for (const [value, label] of rows) {
    const row = document.createElement('div');
    row.className = 'stat';
    const b = document.createElement('b');
    b.textContent = value;
    const span = document.createElement('span');
    span.textContent = label;
    row.append(b, span);
    railStatsEl.appendChild(row);
  }
}

// --------------------------------------------------------------- insights

/*
 * The Statistika pane is a dashboard of six cards over two tabs, and every figure on it
 * is arithmetic over history.json — there is nothing else to read. That constraint is
 * what shaped the cards: no "you are in the top 1% of users", because we have never seen
 * another user; no per-application breakdown, because a dictation is pasted into whatever
 * had focus and we never learn what that was. What the log does know is when you spoke,
 * for how long, in which language and how many words came back, so those are the panels.
 */

const chartEl = el<HTMLElement>('chart');

function renderInsights(): void {
  const stats = computeStats(entries);
  renderQuota();
  renderHeadline(stats);
  renderRhythm();
  renderStreak(stats);
  renderVoice(stats);
  renderChart();
}

/**
 * The weekly allowance — the one card on this pane that does not come from history.json.
 *
 * It reads `account.plan`, which is whatever the server last said, and never recomputes the
 * figure locally. That is not laziness: the server is the thing that enforces the limit, and
 * a second opinion derived from the local log would be wrong for anyone who turned history
 * off, cleared it, or dictates from a second machine. Two numbers that disagree about how
 * much of somebody's week is left is worse than one number that is occasionally a few
 * seconds stale.
 */
function renderQuota(): void {
  const plan = account.plan;

  // Signed out, or the first snapshot has not landed yet. The card stays, saying so — hiding
  // it would make the pane silently change shape depending on a request in flight.
  if (!account.user || !plan) {
    el<HTMLElement>('quotaUsed').textContent = '—';
    el<HTMLElement>('quotaOf').textContent = '';
    el<HTMLElement>('quotaPlan').textContent = '';
    el<HTMLElement>('quotaBar').style.width = '0%';
    el<HTMLElement>('quotaNote').textContent = account.user
      ? 'Yuklanmoqda…'
      : 'Kirgandan so‘ng shu yerda haftalik limit ko‘rinadi.';
    el<HTMLElement>('quotaActions').classList.add('hidden');
    return;
  }

  const isPro = plan.plan === 'pro';
  const left = Math.max(0, plan.wordLimit - plan.wordsUsed);
  const ratio = plan.wordLimit > 0 ? Math.min(1, plan.wordsUsed / plan.wordLimit) : 0;

  el<HTMLElement>('quotaUsed').textContent = formatNumber(plan.wordsUsed);
  el<HTMLElement>('quotaOf').textContent =
    `/ ${formatNumber(plan.wordLimit)} so‘z — ${formatNumber(left)} qoldi`;
  el<HTMLElement>('quotaPlan').textContent = isPro ? 'Pro' : 'Bepul';

  const bar = el<HTMLElement>('quotaBar');
  bar.style.width = `${Math.round(ratio * 100)}%`;
  bar.className = ratio >= 1 ? 'out' : ratio >= 0.66 ? 'low' : '';

  const resets = formatResetDay(plan.resetsAt);
  el<HTMLElement>('quotaNote').textContent =
    left === 0
      ? resets
        ? `Limit tugadi. ${resets} kuni yangilanadi.`
        : 'Limit tugadi — dushanbadan yangilanadi.'
      : resets
        ? `Har dushanba yangilanadi — keyingisi ${resets}.`
        : 'Har dushanba yangilanadi.';

  // Only ever offered on the free plan, and only as a button — the pitch itself lives in the
  // welcome flow and the Hisob pane. A statistics screen that nagged would be a statistics
  // screen people stop opening.
  el<HTMLElement>('quotaActions').classList.toggle('hidden', isPro);
}

el<HTMLButtonElement>('quotaUpgrade').addEventListener('click', () => void show('account'));

/** Rate an average typist sustains, and the baseline the "time saved" figure is measured against. */
const TYPING_WPM = 40;

const LANGUAGE_NAMES: Record<Language, string> = {
  uz: 'O‘zbekcha',
  ru: 'Ruscha',
  en: 'Inglizcha'
};

function renderHeadline(stats: Stats): void {
  el<HTMLElement>('statWpm').textContent = String(stats.wpm);
  renderGauge(stats);

  /*
   * Typing the same words at TYPING_WPM, minus the time actually spent speaking them.
   * Labelled as an estimate in the UI because that is what it is — but it is the number
   * that answers "was this worth installing?", which no exact figure here does.
   */
  const typingSeconds = (stats.words / TYPING_WPM) * 60;
  const saved = Math.max(0, Math.round(typingSeconds - stats.seconds));
  const savedEl = el<HTMLElement>('statSaved');
  savedEl.textContent = formatDuration(saved);
  // "2 soat 16 daq" is a figure with eleven characters in it — see `.figure.long`.
  savedEl.classList.toggle('long', savedEl.textContent.length > 7);
  el<HTMLElement>('statDictations').textContent = formatCount(stats.dictations);
  el<HTMLElement>('statAvgWords').textContent = String(
    stats.dictations > 0 ? Math.round(stats.words / stats.dictations) : 0
  );

  el<HTMLElement>('statWords').textContent = formatCount(stats.words);
  renderDelta();
  renderLanguages();
}

/** Words in the `days` days ending now. */
function wordsSince(days: number, endingDaysAgo = 0): number {
  const now = Date.now();
  const end = now - endingDaysAgo * DAY_MS;
  const start = end - days * DAY_MS;
  return entries
    .filter((entry) => entry.createdAt > start && entry.createdAt <= end)
    .reduce((sum, entry) => sum + countWords(entry.text), 0);
}

/**
 * The last 30 days against the 30 before them.
 *
 * Hidden rather than shown as +100% when there is no earlier month to compare with: a
 * first week of use is not a rise, and the pill is only worth the space when it means
 * something.
 */
function renderDelta(): void {
  const pill = el<HTMLElement>('statDelta');
  const recent = wordsSince(30);
  const previous = wordsSince(30, 30);
  if (previous === 0 || recent === 0) {
    pill.hidden = true;
    return;
  }
  const change = Math.round(((recent - previous) / previous) * 100);
  pill.hidden = false;
  pill.textContent = `${change >= 0 ? '↗' : '↘'} ${change >= 0 ? '+' : ''}${change}% bu oy`;
}

function renderLanguages(): void {
  const host = el<HTMLElement>('statLangs');
  host.replaceChildren();

  const totals = new Map<Language, number>();
  for (const entry of entries) {
    totals.set(entry.language, (totals.get(entry.language) ?? 0) + countWords(entry.text));
  }

  const rows = [...totals.entries()].filter(([, words]) => words > 0).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'metric-row';
    const span = document.createElement('span');
    span.textContent = 'Hali diktovka yo‘q.';
    empty.appendChild(span);
    host.appendChild(empty);
    return;
  }

  for (const [language, words] of rows) {
    const row = document.createElement('div');
    row.className = 'metric-row';
    const b = document.createElement('b');
    b.textContent = LANGUAGE_NAMES[language];
    const span = document.createElement('span');
    span.className = 'trail';
    span.textContent = `${formatCount(words)} so‘z`;
    row.append(b, span);
    host.appendChild(row);
  }
}

// ------------------------------------------------------------------ gauge

/** Where the arc ends. Above this the needle simply pins — nobody dictates at 220. */
const GAUGE_MAX_WPM = 200;

/**
 * A half-circle from 0 to GAUGE_MAX_WPM, drawn as one stroked arc with a dash offset.
 *
 * SVG for the same reason the chart is SVG: this is geometry, and a rotated box with a
 * clipped overflow would be three elements pretending to be one shape.
 */
function renderGauge(stats: Stats): void {
  const host = el<HTMLElement>('wpmGauge');
  host.replaceChildren();

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 160 92');
  svg.setAttribute('aria-hidden', 'true');

  // Both halves are the same path; only the dash pattern differs.
  const d = 'M 14 84 A 66 66 0 0 1 146 84';
  const length = Math.PI * 66;
  const share = Math.min(1, stats.wpm / GAUGE_MAX_WPM);

  for (const kind of ['track', 'fill'] as const) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', '12');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('class', kind);
    if (kind === 'fill') {
      path.setAttribute('stroke-dasharray', `${length * share} ${length}`);
      // The keyframe animates from a full offset, so the arc sweeps in from zero.
      path.style.setProperty('--dash-len', String(length * share));
    }
    svg.appendChild(path);
  }

  const cap = document.createElement('div');
  cap.className = 'cap';
  const label = document.createElement('span');
  const value = document.createElement('b');
  if (stats.bestWpm > 0) {
    label.textContent = 'Eng tez';
    value.textContent = String(stats.bestWpm);
  } else {
    label.textContent = 'Hali';
    value.textContent = '—';
  }
  cap.append(label, value);

  host.append(svg, cap);
}

// ------------------------------------------------------------- day rhythm

/**
 * When the day's dictations happen, in four buckets.
 *
 * Local hours, because the question is "when do you work?" and the answer is only ever
 * asked in the clock on the wall next to the person asking it.
 */
const RHYTHM: Array<{ label: string; icon: string; from: number; to: number }> = [
  { label: 'Ertalab', icon: 'sunrise', from: 5, to: 12 },
  { label: 'Kunduzi', icon: 'sun', from: 12, to: 17 },
  { label: 'Kechqurun', icon: 'sunset', from: 17, to: 22 },
  { label: 'Tun', icon: 'moon', from: 22, to: 5 }
];

function renderRhythm(): void {
  const host = el<HTMLElement>('rhythmRows');
  host.replaceChildren();

  const counts = RHYTHM.map(
    (bucket) =>
      entries.filter((entry) => {
        const hour = new Date(entry.createdAt).getHours();
        // The night bucket wraps midnight, so it is the one that reads as an "or".
        return bucket.from < bucket.to
          ? hour >= bucket.from && hour < bucket.to
          : hour >= bucket.from || hour < bucket.to;
      }).length
  );

  const total = counts.reduce((sum, count) => sum + count, 0);
  const busiest = Math.max(...counts, 1);
  el<HTMLElement>('rhythmTotal').textContent = String(total);

  RHYTHM.forEach((bucket, index) => {
    const count = counts[index];
    const share = total > 0 ? Math.round((count / total) * 100) : 0;

    const row = document.createElement('div');
    row.className = share > 0 ? 'usage-row' : 'usage-row quiet';

    const ico = document.createElement('div');
    ico.className = 'ico';
    ico.innerHTML = icon(bucket.icon, 17);

    const wrap = document.createElement('div');
    wrap.className = 'barwrap';
    const bar = document.createElement('div');
    bar.className = 'bar';
    /*
     * The track is the busiest part of the day, not 100%: four buckets can't each hold
     * much of the total, and bars drawn against 100% would all be stubs. The lengths stay
     * proportional to each other — it is a scaled axis, and the label on each bar still
     * carries the true share.
     */
    bar.style.width = `${Math.round((count / busiest) * 100)}%`;
    bar.textContent = `${share}%`;
    wrap.appendChild(bar);

    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `${bucket.label} · ${count} ta`;

    row.append(ico, wrap, what);
    host.appendChild(row);
  });
}

// --------------------------------------------------------------- heat map

/**
 * Weekday names indexed by `Date#getDay()` — so Sunday is 0, because that is what the
 * platform hands back. Read through this table, never sliced: the *display* order is Monday
 * first (see HEAT_ROWS), and conflating the two is how a heat map ends up one row out.
 */
const WEEKDAYS_BY_GETDAY = ['Ya', 'Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh'];

/**
 * The rows of the heat map, top to bottom: Monday first.
 *
 * It used to be Sunday first, which is neither the week Uzbekistan keeps nor — since the
 * quota became words per week — the week the app is measuring. A column that started on
 * Sunday while the allowance reset on Monday would put the first day of the user's new
 * allowance in the *middle* of the last column, and there is no reading of that picture that
 * tells them anything true.
 */
const HEAT_ROWS = [1, 2, 3, 4, 5, 6, 0];

const MONTHS = ['Yan', 'Fev', 'Mar', 'Apr', 'May', 'Iyn', 'Iyl', 'Avg', 'Sen', 'Okt', 'Noy', 'Dek'];

const WEEK_MS = 7 * DAY_MS;

/**
 * Midnight on the Monday of the week `ts` falls in, local time.
 *
 * The same boundary Postgres uses for the quota
 * (date_trunc('week') is ISO, so Monday) — restated here because the heat map is drawn from
 * the local log, not from the server. `(getDay() + 6) % 7` maps Sunday's 0 to 6, which is
 * what makes Sunday the *last* day of the week it belongs to rather than the first day of
 * the next one.
 */
function startOfWeek(ts: number): number {
  const day = startOfDay(ts);
  return day - ((new Date(day).getDay() + 6) % 7) * DAY_MS;
}
/** Columns on screen at once — about four months, which is what the card is wide enough for. */
const HEAT_WEEKS = 18;
/** How far back the arrows have walked, in weeks. */
let heatOffset = 0;

function renderStreak(stats: Stats): void {
  el<HTMLElement>('streakTitle').textContent = `${stats.streak} kun ketma-ket`;
  el<HTMLElement>('streakBest').textContent = String(stats.longestStreak);
  renderHeat(stats);

  const oldest =
    entries.length > 0 ? Math.min(...entries.map((entry) => entry.createdAt)) : Date.now();
  const weeksOfHistory = Math.ceil((Date.now() - oldest) / WEEK_MS);
  el<HTMLButtonElement>('heatPrev').disabled = heatOffset >= Math.max(0, weeksOfHistory - 4);
  el<HTMLButtonElement>('heatNext').disabled = heatOffset === 0;
}

function renderHeat(stats: Stats): void {
  const host = el<HTMLElement>('heatmap');
  host.replaceChildren();

  const today = startOfDay(Date.now());
  // Columns are calendar weeks starting Monday, so the last one is the week we are in — and
  // the week the current allowance belongs to.
  const thisWeek = startOfWeek(today);
  const firstWeek = thisWeek - (HEAT_WEEKS - 1 + heatOffset) * WEEK_MS;

  const peak = Math.max(...stats.byDay.values(), 1);

  const months = document.createElement('div');
  months.className = 'months';
  months.style.gridTemplateColumns = `repeat(${HEAT_WEEKS}, 1fr)`;

  const days = document.createElement('div');
  days.className = 'days';
  // Every other row only — seven labels at this size is a wall of text, and the rows in
  // between are read by position anyway. With Monday first that names Du, Ch, Ju.
  HEAT_ROWS.forEach((weekday, index) => {
    const label = document.createElement('span');
    label.textContent = index % 2 === 0 ? WEEKDAYS_BY_GETDAY[weekday] : '';
    days.appendChild(label);
  });

  const cells = document.createElement('div');
  cells.className = 'cells';
  cells.style.gridTemplateColumns = `repeat(${HEAT_WEEKS}, 1fr)`;

  let lastMonth = -1;
  for (let week = 0; week < HEAT_WEEKS; week++) {
    const columnStart = new Date(firstWeek + week * WEEK_MS);
    if (columnStart.getMonth() !== lastMonth) {
      lastMonth = columnStart.getMonth();
      // Not on the final column: a label there has nothing under it to name.
      if (week < HEAT_WEEKS - 1) {
        const label = document.createElement('span');
        label.style.gridColumn = `${week + 1} / span 3`;
        label.textContent = MONTHS[lastMonth];
        months.appendChild(label);
      }
    }

    for (let day = 0; day < 7; day++) {
      const date = firstWeek + week * WEEK_MS + day * DAY_MS;
      const words = stats.byDay.get(date) ?? 0;
      const cell = document.createElement('i');

      if (date > today) cell.className = 'future';
      else if (words > 0) {
        const level = Math.min(4, Math.ceil((words / peak) * 4));
        cell.className = `l${level}`;
      }
      if (
        stats.streakEnd > 0 &&
        date <= stats.streakEnd &&
        date > stats.streakEnd - stats.streak * DAY_MS
      ) {
        cell.classList.add('streak');
      }

      cell.title = date > today ? '' : `${formatDateNumeric(date)} — ${formatNumber(words)} so‘z`;
      cells.appendChild(cell);
    }
  }

  host.append(months, days, cells);
}

el<HTMLButtonElement>('heatPrev').addEventListener('click', () => {
  heatOffset += 4;
  renderStreak(computeStats(entries));
});

el<HTMLButtonElement>('heatNext').addEventListener('click', () => {
  heatOffset = Math.max(0, heatOffset - 4);
  renderStreak(computeStats(entries));
});

// ------------------------------------------------------------- your voice

/**
 * Words too common to be interesting in a "what do you talk about" list.
 *
 * Deliberately short and deliberately three-language: the list only has to keep the top of
 * the chips from being the same four function words for everybody. Anything below four
 * characters is dropped outright, which handles most of the rest.
 */
const STOP_WORDS = new Set([
  'uchun',
  'bilan',
  'keyin',
  'lekin',
  'ammo',
  'ular',
  'meni',
  'sizga',
  'menga',
  'ham',
  'yoki',
  'kerak',
  'bo‘ldi',
  'что',
  'это',
  'как',
  'так',
  'вот',
  'быть',
  'если',
  'when',
  'that',
  'this',
  'with',
  'have',
  'from',
  'they',
  'there',
  'about',
  'just',
  'because'
]);

function renderVoice(stats: Stats): void {
  const host = el<HTMLElement>('voiceRows');
  host.replaceChildren();

  const rows: Array<[string, string]> = [
    ['Eng tez diktovka', stats.bestWpm > 0 ? `${stats.bestWpm} so‘z/daq` : '—'],
    ['Eng uzun diktovka', formatDuration(Math.round(stats.longestMs / 1000))],
    [
      'O‘rtacha davomiylik',
      formatDuration(stats.dictations > 0 ? Math.round(stats.seconds / stats.dictations) : 0)
    ],
    ['Jami gapirilgan', formatDuration(stats.seconds)],
    [
      'Faol kunda o‘rtacha',
      `${stats.activeDays > 0 ? Math.round(stats.words / stats.activeDays) : 0} so‘z`
    ]
  ];

  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'metric-row';
    const span = document.createElement('span');
    span.textContent = label;
    const b = document.createElement('b');
    b.className = 'trail';
    b.textContent = value;
    row.append(span, b);
    host.appendChild(row);
  }

  renderTopWords();
}

function renderTopWords(): void {
  const host = el<HTMLElement>('topWords');
  host.replaceChildren();

  // The same notion of a word the counter uses, so the two panes can't disagree.
  const pattern = new RegExp(`[\\p{L}\\p{N}${WORD_CHARS}]+`, 'gu');
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const match of entry.text.toLowerCase().matchAll(pattern)) {
      const word = match[0];
      if (word.length < 4 || STOP_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  const top = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16);

  if (top.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'insight-empty';
    empty.textContent = 'Bir nechta diktovkadan keyin shu yerda paydo bo‘ladi.';
    host.appendChild(empty);
    return;
  }

  for (const [word, count] of top) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    const b = document.createElement('b');
    // A transcript is arbitrary text; this is the one place in the pane that renders it.
    b.textContent = word;
    const span = document.createElement('span');
    span.textContent = String(count);
    chip.append(b, span);
    host.appendChild(chip);
  }
}

// ----------------------------------------------------------------- tabs

/*
 * The chart is redrawn on every switch rather than once: a bar that grows from the axis
 * while its pane is `display: none` has finished growing by the time anyone sees it.
 */
for (const tab of document.querySelectorAll<HTMLButtonElement>('#insightTabs .tab')) {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    for (const other of document.querySelectorAll<HTMLElement>('#insightTabs .tab')) {
      const on = other === tab;
      other.classList.toggle('on', on);
      other.setAttribute('aria-selected', String(on));
    }
    for (const pane of document.querySelectorAll<HTMLElement>('.tab-pane')) {
      pane.classList.toggle('on', pane.dataset.tab === name);
    }
    if (name === 'voice') renderChart();
  });
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Drawing height of the chart in CSS pixels; the SVG has no viewBox, so 1 unit = 1 px. */
const CHART_H = 112;

function renderChart(): void {
  const today = startOfDay(Date.now());
  const buckets: number[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = today - i * DAY_MS;
    const words = entries
      .filter((entry) => startOfDay(entry.createdAt) === day)
      .reduce((sum, entry) => sum + countWords(entry.text), 0);
    buckets.push(words);
  }

  const peak = Math.max(...buckets, 1);
  chartEl.replaceChildren();

  /*
   * Drawn as SVG rather than as a row of divs, and that is a deliberate retreat: as DOM
   * elements the bars would not keep the height they were given — flex item, absolutely
   * positioned, pixels, percentages and `!important` all resolved to the full height of
   * the chart, so every wordless day drew a full-height slab that read as a day of solid
   * dictation. In SVG the height is geometry rather than a layout suggestion.
   *
   * No viewBox: the SVG's user units are CSS pixels, so `rx` stays round and only the x
   * axis is expressed in percentages, which is exactly the axis that should stretch with
   * the window.
   */
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(CHART_H));
  svg.setAttribute('role', 'img');

  const slot = 100 / buckets.length;

  buckets.forEach((words, index) => {
    const date = new Date(today - (13 - index) * DAY_MS);
    // A floor of 3px so a wordless day is still a visible tick rather than nothing at all.
    const height = words > 0 ? Math.max(7, (words / peak) * (CHART_H - 4)) : 3;

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', `${index * slot + slot * 0.18}%`);
    rect.setAttribute('width', `${slot * 0.64}%`);
    rect.setAttribute('y', String(CHART_H - height));
    rect.setAttribute('height', String(height));
    rect.setAttribute('rx', '5');
    rect.setAttribute('class', words > 0 ? 'bar' : 'bar empty');
    rect.style.animationDelay = `${index * 26}ms`;

    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${formatDateNumeric(date.getTime())} — ${formatNumber(words)} so‘z`;
    rect.appendChild(title);

    svg.appendChild(rect);
  });

  const labels = document.createElement('div');
  labels.className = 'labels';
  buckets.forEach((_, index) => {
    const label = document.createElement('div');
    label.textContent = WEEKDAYS_BY_GETDAY[new Date(today - (13 - index) * DAY_MS).getDay()];
    labels.appendChild(label);
  });

  chartEl.append(svg, labels);
}

// ------------------------------------------------------------------- style

const styleFillersEl = el<HTMLInputElement>('styleFillers');
const stylePunctuationEl = el<HTMLInputElement>('stylePunctuation');
const stylePreviewEl = el<HTMLElement>('stylePreview');
const languageEl = el<HTMLSelectElement>('language');

/**
 * What each tone does to the same sentence.
 *
 * Written out rather than generated, and labelled as a recording in the UI: showing a live
 * example would mean spending a real transcription every time somebody clicked a radio
 * button, and the point of the preview is to explain the setting, not to prove it.
 */
const TONE_SAMPLES: Record<StyleSettings['tone'], string> = {
  verbatim:
    'salom, men bugun, ha, bugun ertalab yig‘ilishga bora olmayman, chunki shifokorga yozilganman',
  tidy: 'salom, men bugun ertalab yig‘ilishga bora olmayman, chunki shifokorga yozilganman',
  formal:
    'assalomu alaykum. bugun ertalabki yig‘ilishda qatnasha olmayman — shifokor qabuliga yozilganman.'
};

function selectedTone(): StyleSettings['tone'] {
  const checked = document.querySelector<HTMLInputElement>('input[name="tone"]:checked');
  const value = checked?.value;
  return value === 'tidy' || value === 'formal' ? value : 'verbatim';
}

function renderStyle(): void {
  const style = settings.style;
  const radio = document.querySelector<HTMLInputElement>(
    `input[name="tone"][value="${style.tone}"]`
  );
  if (radio) radio.checked = true;
  styleFillersEl.checked = style.removeFillers;
  stylePunctuationEl.checked = style.punctuation;
  languageEl.value = settings.language;
  paintStyle();
}

/** Reflect the current choices — the selected card, and the sample sentence. */
function paintStyle(): void {
  const tone = selectedTone();
  for (const choice of document.querySelectorAll<HTMLElement>('.choice')) {
    choice.classList.toggle('on', choice.dataset.tone === tone);
  }

  let sample = TONE_SAMPLES[tone];
  if (!styleFillersEl.checked && tone === 'verbatim') {
    sample = sample.replace('men bugun, ha, bugun', 'men, eee, bugun, ha, bugun');
  }
  if (stylePunctuationEl.checked) {
    sample = sample.charAt(0).toUpperCase() + sample.slice(1);
  } else {
    sample = sample
      .replace(/[.,—;:!?]/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  // Re-trigger the fade so a change is visible even when the text barely moves.
  stylePreviewEl.style.opacity = '0';
  stylePreviewEl.textContent = sample;
  requestAnimationFrame(() => {
    stylePreviewEl.style.opacity = '1';
  });
}

async function saveStyle(): Promise<void> {
  paintStyle();
  const style: StyleSettings = {
    tone: selectedTone(),
    removeFillers: styleFillersEl.checked,
    punctuation: stylePunctuationEl.checked
  };
  if (await patch({ style })) toast('Saqlandi');
}

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="tone"]')) {
  input.addEventListener('change', () => void saveStyle());
}
styleFillersEl.addEventListener('change', () => void saveStyle());
stylePunctuationEl.addEventListener('change', () => void saveStyle());

languageEl.addEventListener('change', () => {
  void patch({ language: languageEl.value as Language }).then((ok) => ok && toast('Saqlandi'));
});

// -------------------------------------------------------------- scratchpad

const scratchpadEl = el<HTMLTextAreaElement>('scratchpadText');
const scratchpadMsgEl = el<HTMLElement>('scratchpadMsg');
let scratchpadTimer: number | undefined;

scratchpadEl.addEventListener('input', () => {
  scratchpadMsgEl.textContent = 'Saqlanmoqda…';
  // Debounced: this fires on every keystroke, and a dictation into the pane arrives as a
  // burst of them. One write per pause is plenty.
  window.clearTimeout(scratchpadTimer);
  scratchpadTimer = window.setTimeout(async () => {
    const words = countWords(scratchpadEl.value);
    if (await patch({ scratchpad: scratchpadEl.value })) {
      scratchpadMsgEl.textContent = `Saqlandi · ${words} so‘z`;
    }
  }, 600);
});

// ---------------------------------------------------------------- settings

const settingsModalEl = el<HTMLElement>('settingsModal');
const deviceEl = el<HTMLSelectElement>('device');
const micTestEl = el<HTMLButtonElement>('micTest');
const micMsgEl = el<HTMLElement>('micMsg');
const userNameEl = el<HTMLInputElement>('userName');
const launchEl = el<HTMLInputElement>('launchAtLogin');
const showIdlePillEl = el<HTMLInputElement>('showIdlePill');
const saveHistoryEl = el<HTMLInputElement>('saveHistory');
const meter = createMeter(el<HTMLElement>('meter'));

/**
 * Everything in the modal saves the moment it changes — there is no Save button.
 *
 * With a key and a model in here that would have been the wrong call: a half-typed key
 * saved on every keystroke is a broken key. What is left is a device, a language, a name
 * and three switches, and for those a Save button is only a way to lose your change by
 * closing the window.
 */
function bindInstantSave(): void {
  deviceEl.addEventListener('change', () => void patch({ deviceId: deviceEl.value }));
  launchEl.addEventListener('change', () => void patch({ launchAtLogin: launchEl.checked }));
  showIdlePillEl.addEventListener(
    'change',
    () => void patch({ showIdlePill: showIdlePillEl.checked })
  );
  saveHistoryEl.addEventListener(
    'change',
    () => void patch({ saveHistory: saveHistoryEl.checked })
  );

  // On `change` rather than `input`: the greeting reads better when it updates once, on the
  // way out of the field, than on every letter of somebody's name.
  userNameEl.addEventListener('change', async () => {
    if (!(await patch({ userName: userNameEl.value }))) return;
    settings = await window.api.getSettings();
    userNameEl.value = settings.userName;
    renderGreeting();
  });
}

bindInstantSave();

micTestEl.addEventListener('click', () => {
  void micTest.toggle(deviceEl.value, meter, micTestEl, micMsgEl);
});

el<HTMLButtonElement>('copyPath').addEventListener('click', () => {
  void window.api.copyText(el<HTMLElement>('historyPath').textContent ?? '');
  toast('Manzil nusxalandi');
});

el<HTMLButtonElement>('clearAll').addEventListener('click', () => {
  if (entries.length === 0) return;
  if (!confirm(`${entries.length} ta yozuv butunlay o‘chiriladi. Davom etamizmi?`)) return;
  void window.api.clearHistory();
  toast('Tarix tozalandi');
});

/** Which group of rows the modal is showing. */
function showSettingsPane(name: string): void {
  for (const pane of document.querySelectorAll<HTMLElement>('.modal-pane')) {
    pane.classList.toggle('on', pane.dataset.pane === name);
  }
  for (const item of document.querySelectorAll<HTMLElement>('.modal-nav-item')) {
    item.classList.toggle('on', item.dataset.pane === name);
  }
}

for (const item of document.querySelectorAll<HTMLElement>('.modal-nav-item')) {
  item.addEventListener('click', () => showSettingsPane(item.dataset.pane ?? 'general'));
}

async function openSettings(): Promise<void> {
  // Re-read rather than trusting the cache: a dictation into the notes pane, or a second
  // window, can have changed something since this one last looked.
  settings = await window.api.getSettings();
  userNameEl.value = settings.userName;
  languageEl.value = settings.language;
  launchEl.checked = settings.launchAtLogin;
  showIdlePillEl.checked = settings.showIdlePill;
  saveHistoryEl.checked = settings.saveHistory;

  showSettingsPane('general');
  settingsModalEl.classList.remove('hidden');
  // The sidebar item stays lit while the modal is up, so it is obvious what is open.
  for (const button of document.querySelectorAll<HTMLElement>('.nav-item')) {
    button.classList.toggle('on', button.dataset.section === 'settings');
  }

  const count = await fillDevices(deviceEl, settings.deviceId);
  if (count === 0) setMsg(micMsgEl, 'Mikrofon topilmadi — ffmpeg o‘rnatilganini tekshiring', 'err');
}

async function closeSettings(): Promise<void> {
  // The microphone must not stay open behind a closed dialog.
  await micTest.stop();
  setMsg(micMsgEl, '');
  settingsModalEl.classList.add('hidden');
  // Put the highlight back on whichever pane is actually showing underneath.
  const open = [...views].find(([, view]) => view.classList.contains('on'))?.[0];
  for (const button of document.querySelectorAll<HTMLElement>('.nav-item')) {
    button.classList.toggle('on', button.dataset.section === open);
  }
}

el<HTMLButtonElement>('settingsClose').addEventListener('click', () => void closeSettings());
el<HTMLElement>('settingsScrim').addEventListener('click', () => void closeSettings());

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || settingsModalEl.classList.contains('hidden')) return;
  void closeSettings();
});

function renderGreeting(): void {
  const name = settings.userName.trim();
  greetingEl.textContent = name ? `Xush kelibsiz, ${name}` : 'Xush kelibsiz';
}

// ----------------------------------------------------------------- updates

const updateCheckEl = el<HTMLButtonElement>('updateCheck');
const updateInstallEl = el<HTMLButtonElement>('updateInstall');
const updateMsgEl = el<HTMLElement>('updateMsg');

updateCheckEl.addEventListener('click', () => void window.api.checkForUpdates());
updateInstallEl.addEventListener('click', () => void window.api.installUpdate());

/** A ready update is the only thing that puts a badge on the Settings item. */
function setSettingsBadge(on: boolean): void {
  const item = document.querySelector<HTMLElement>('.nav-item[data-section="settings"]');
  if (!item) return;
  const existing = item.querySelector('.dot');
  if (on && !existing) {
    const dot = document.createElement('span');
    dot.className = 'dot tail';
    dot.textContent = '1';
    item.appendChild(dot);
  } else if (!on && existing) {
    existing.remove();
  }
}

window.api.onUpdateStatus((status: UpdateStatus) => {
  updateInstallEl.classList.toggle('hidden', status.state !== 'ready');
  updateCheckEl.disabled = status.state === 'checking' || status.state === 'downloading';
  setSettingsBadge(status.state === 'ready');

  switch (status.state) {
    case 'checking':
      setMsg(updateMsgEl, 'Tekshirilmoqda…');
      break;
    case 'available':
      setMsg(updateMsgEl, `${status.version} versiyasi topildi — yuklab olinmoqda`);
      break;
    case 'downloading':
      setMsg(updateMsgEl, `Yuklanmoqda… ${status.percent ?? 0}%`);
      break;
    case 'ready':
      setMsg(updateMsgEl, `${status.version} yuklab olindi — o‘rnatishga tayyor`, 'ok');
      break;
    case 'error':
      setMsg(updateMsgEl, status.message ?? 'Yangilanishni tekshirib bo‘lmadi', 'warn');
      break;
    case 'unsupported':
      setMsg(updateMsgEl, status.message ?? 'Yangilash mavjud emas');
      updateCheckEl.disabled = true;
      break;
    case 'idle':
      setMsg(updateMsgEl, 'Eng so‘nggi versiya o‘rnatilgan');
      break;
  }
});

// -------------------------------------------------------------------- help

// Copying rather than opening: the renderer has no shell access by design, and the tray
// menu's "Loglar papkasi" already opens the folder from main, where it belongs.
el<HTMLButtonElement>('openLogs').addEventListener('click', () => {
  void window.api.copyText(el<HTMLElement>('helpPath').textContent ?? '');
  toast('Manzil nusxalandi');
});

// ----------------------------------------------------------------- account

/**
 * The account pane.
 *
 * Main owns the session; this draws what it is told and asks for changes. In particular there
 * is no token here and never should be — `AccountState` carries a name, an email and two
 * counters, which is everything this window needs to render and nothing it could leak.
 *
 * Sign-in is the one flow in the app that does not resolve where it starts: the button opens
 * a browser and returns immediately, and the signed-in state arrives later on
 * `onAccountChanged`. Every button below is written for that — none of them await a result
 * that will not come.
 */
const accSignedOutEl = el<HTMLElement>('accountSignedOut');
const accSignedInEl = el<HTMLElement>('accountSignedIn');
const accMsgEl = el<HTMLElement>('accMsg');
const accPlanMsgEl = el<HTMLElement>('accPlanMsg');
const accBarEl = el<HTMLElement>('accBarFill');
const wAuthMsgEl = el<HTMLElement>('wAuthMsg');

/** Tiyin to a readable so'm figure: 5000000 -> "50 000 so'm". */
function formatSom(tiyin: number): string {
  const som = Math.round(tiyin / 100);
  return `${som.toLocaleString('ru-RU').replace(/ /g, ' ')} so‘m`;
}

/** Initials for the avatar circle. Falls back to the email when Google sent no name. */
function initials(name: string, email: string): string {
  const source = name.trim() || email.trim();
  if (!source) return '?';
  const parts = source.split(/[\s.@_-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0][0] + parts[1][0];
}

function renderAccount(): void {
  const signedIn = account.user !== null;
  accSignedOutEl.classList.toggle('hidden', signedIn);
  accSignedInEl.classList.toggle('hidden', !signedIn);

  setMsg(accMsgEl, account.error, account.error ? 'err' : '');
  // The welcome screen's copy of the sign-in state, so a failure there is visible without
  // making the user close the welcome flow to find out why nothing happened.
  setMsg(
    wAuthMsgEl,
    account.error || (signedIn ? `Kirdingiz: ${account.user?.email ?? ''}` : ''),
    account.error ? 'err' : signedIn ? 'ok' : ''
  );

  renderWelcomeAuth();

  if (!account.user) return;

  // textContent, not innerHTML: a display name comes from Google and is arbitrary text.
  el<HTMLElement>('accAvatar').textContent = initials(account.user.name, account.user.email);
  el<HTMLElement>('accName').textContent = account.user.name || 'Hisob';
  el<HTMLElement>('accEmail').textContent = account.user.email;

  const plan = account.plan;
  const isPro = plan?.plan === 'pro';

  el<HTMLElement>('accPlanName').textContent = isPro ? 'Pro' : 'Bepul';
  el<HTMLElement>('accPlanBadge').textContent = isPro ? 'Pro' : 'Free';
  el<HTMLElement>('accPlanBadge').className = isPro ? 'badge new' : 'badge';

  const upgradeEl = el<HTMLButtonElement>('accUpgrade');
  upgradeEl.classList.toggle('hidden', isPro);
  if (plan && plan.priceTiyin > 0) {
    upgradeEl.textContent = `Pro’ga o‘tish — ${formatSom(plan.priceTiyin)}/oy`;
  }

  // `plan === null` is "we haven't heard back yet", which must not be drawn as 0 / 0 — that
  // reads as a broken account rather than a pending request.
  if (!plan) {
    el<HTMLElement>('accUsage').textContent = 'Yuklanmoqda…';
    accBarEl.style.width = '0%';
    el<HTMLElement>('accExpires').textContent = '';
    return;
  }

  const left = Math.max(0, plan.wordLimit - plan.wordsUsed);
  el<HTMLElement>('accUsage').textContent =
    `Bu hafta: ${formatNumber(plan.wordsUsed)} / ${formatNumber(plan.wordLimit)} so‘z — ` +
    `${formatNumber(left)} so‘z qoldi`;

  const ratio = plan.wordLimit > 0 ? Math.min(1, plan.wordsUsed / plan.wordLimit) : 0;
  accBarEl.style.width = `${Math.round(ratio * 100)}%`;
  accBarEl.className = ratio >= 1 ? 'out' : ratio >= 0.66 ? 'low' : '';

  // Two different dates, and they are not interchangeable: the allowance comes back every
  // Monday whatever the plan, while Pro itself runs out on a date the user paid for. Both are
  // shown when both apply, because "you have no words left" and "your subscription ends
  // Thursday" are answers to different worries.
  const lines: string[] = [];
  const resets = formatResetDay(plan.resetsAt);
  if (resets) lines.push(`Limit yangilanadi: ${resets}`);
  if (isPro && plan.expiresAt) {
    const until = new Date(plan.expiresAt);
    if (!Number.isNaN(until.getTime())) {
      lines.push(`Pro amal qiladi: ${formatDayMonth(until.getTime(), true)} gacha`);
    }
  }
  el<HTMLElement>('accExpires').textContent = lines.join(' · ');
}

/**
 * "24-avgust, dushanba" — when the weekly allowance comes back.
 *
 * The server sends the instant rather than the app working out its own Monday, so this only
 * formats. It still guards the parse: a malformed date drawn as "Invalid Date" next to a
 * quota figure would read as the quota itself being broken.
 */
function formatResetDay(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${formatDayMonth(date.getTime())}, ${WEEKDAY_NAMES[date.getDay()]}`;
}

async function beginSignIn(): Promise<void> {
  setMsg(accMsgEl, 'Brauzer ochilmoqda…');
  setMsg(wAuthMsgEl, 'Brauzer ochilmoqda…');
  const result = await window.api.signIn();
  if (!result.ok) {
    // The Uzbek line main already put on `account.error` is the one to show; this is the
    // fallback for a failure that never reached that state.
    const message = account.error || 'Kirishni boshlab bo‘lmadi';
    setMsg(accMsgEl, message, 'err');
    setMsg(wAuthMsgEl, message, 'err');
    return;
  }
  setMsg(accMsgEl, 'Brauzerda davom eting…');
  setMsg(wAuthMsgEl, 'Brauzerda davom eting…');
}

el<HTMLButtonElement>('accSignIn').addEventListener('click', () => void beginSignIn());
el<HTMLButtonElement>('wSignIn').addEventListener('click', () => void beginSignIn());

el<HTMLButtonElement>('accSignOut').addEventListener('click', async () => {
  await window.api.signOut();
  toast('Chiqdingiz');
});

el<HTMLButtonElement>('accRefresh').addEventListener('click', async () => {
  setMsg(accPlanMsgEl, 'Yangilanmoqda…');
  await window.api.refreshPlan();
  setMsg(accPlanMsgEl, '');
});

el<HTMLButtonElement>('accUpgrade').addEventListener('click', async () => {
  setMsg(accPlanMsgEl, 'To‘lov sahifasi ochilmoqda…');
  const error = await window.api.startCheckout();
  if (error) {
    setMsg(accPlanMsgEl, error, 'err');
    return;
  }
  // The plan flips when Payme calls our server, not when the browser opens — so the honest
  // thing to say is "come back and refresh", not "you are now Pro".
  setMsg(accPlanMsgEl, 'To‘lovdan so‘ng «Yangilash» tugmasini bosing', 'ok');
});

window.api.onAccountChanged((state) => {
  account = state;
  renderAccount();
  // The Statistika pane's weekly-allowance card reads the same snapshot, and it counts up as
  // you dictate — so it has to be re-drawn here rather than only when the pane is opened.
  renderQuota();
  // The plan step's price comes from the same snapshot, and the snapshot lands *after* the
  // sign-in that leads to that step — so the step is very often on screen showing an em dash
  // when this arrives. Redrawing it here is what fills the price in.
  if (isWelcomeOpen() && welcomeStep === STEP_PLAN) renderWelcomePlans();
});

// --------------------------------------------------------------- shortcuts

/**
 * The chord, drawn as keycaps.
 *
 * Built as an HTML string because two of its callers already build markup (the empty-history
 * placeholder, and the `[data-hotkey]` slots scattered through the window). It is safe to do
 * so here and nowhere else: every name in a chord comes from `sanitizeChord`, which accepts
 * only names from a fixed table — see BINDABLE_KEYS in src/shared/hotkeys.ts. Nothing a user
 * types reaches this function.
 */
function capsHtml(chord: Chord): string {
  if (!chord.length) return '<kbd>—</kbd>';
  return chord.map((key) => `<kbd>${keyLabel(key)}</kbd>`).join(' + ');
}

function hotkeyCaps(): string {
  return capsHtml(settings.hotkeys.pushToTalk);
}

/** Fill every place in the window that names the shortcut. Called whenever it changes. */
function renderHotkeyText(): void {
  const html = hotkeyCaps();
  for (const slot of document.querySelectorAll<HTMLElement>('[data-hotkey]')) {
    slot.innerHTML = html;
  }
  el<HTMLElement>('wKeysLead').innerHTML =
    `Tavsiya: ${html}. Boshqa dasturlar bilan urishsa — pastdagi tugmadan o‘zgartiring.`;
  el<HTMLElement>('wTryLead').innerHTML =
    `${html} ni bosib turing, gapiring, qo‘yib yuboring. Matn kursor turgan joyga yoziladi — ` +
    'hozir esa quyidagi maydonga.';
}

// ---------------------------------------------------------- shortcut editor

const hotkeyModalEl = el<HTMLElement>('hotkeyModal');
const hkMsgEl = el<HTMLElement>('hkMsg');

/** Which row is currently listening for keys, if any. */
let hkRecording: keyof HotkeySettings | null = null;
/** Keys seen going down during this recording — accumulated, never removed. */
let hkPressed: string[] = [];
/** Keys still physically down, so the recording can commit when the last one is released. */
const hkHeld = new Set<string>();

const HK_ROWS: { key: keyof HotkeySettings; row: string; keys: string; edit: string }[] = [
  { key: 'pushToTalk', row: 'hkRowPush', keys: 'hkKeysPush', edit: 'hkEditPush' },
  { key: 'handsFree', row: 'hkRowFree', keys: 'hkKeysFree', edit: 'hkEditFree' }
];

el<HTMLButtonElement>('hkEditPush').innerHTML = icon('pencil', 15);
el<HTMLButtonElement>('hkEditFree').innerHTML = icon('pencil', 15);
el<HTMLButtonElement>('hkClearFree').innerHTML = icon('trash', 15);

function renderHotkeyEditor(): void {
  for (const { key, row, keys } of HK_ROWS) {
    const chord = settings.hotkeys[key];
    const box = el<HTMLElement>(keys);
    box.replaceChildren();

    if (hkRecording === key) {
      // Mid-recording the box shows what has been pressed so far, so a chord builds up
      // under the fingers rather than appearing all at once when they let go.
      const shown = hkPressed.length ? sortChord(hkPressed) : [];
      if (!shown.length) box.appendChild(hintSpan('Tugmalarni bosing…'));
      else for (const name of shown) box.appendChild(capSpan(name));
    } else if (!chord.length) {
      box.appendChild(hintSpan('O‘chirilgan'));
    } else {
      for (const name of chord) box.appendChild(capSpan(name));
    }

    el<HTMLElement>(row).classList.toggle('recording', hkRecording === key);
  }

  el<HTMLButtonElement>('hkClearFree').classList.toggle(
    'hidden',
    settings.hotkeys.handsFree.length === 0
  );
}

function capSpan(name: string): HTMLElement {
  const cap = document.createElement('span');
  cap.className = 'hk-cap';
  cap.textContent = keyLabel(name);
  return cap;
}

function hintSpan(text: string): HTMLElement {
  const hint = document.createElement('span');
  hint.className = 'hk-empty';
  hint.textContent = text;
  return hint;
}

function startRecording(key: keyof HotkeySettings): void {
  hkRecording = key;
  hkPressed = [];
  hkHeld.clear();
  setMsg(hkMsgEl, 'Kerakli tugmalarni bosib turing va qo‘yib yuboring. Bekor qilish — Esc.');
  renderHotkeyEditor();
}

function stopRecording(): void {
  hkRecording = null;
  hkPressed = [];
  hkHeld.clear();
  renderHotkeyEditor();
}

/**
 * Record a chord from this window's own key events.
 *
 * DOM events rather than the global hook, and that is right here even though the *test* on
 * the welcome flow's fourth step deliberately uses the hook: recording is a thing done to a
 * focused dialog, and `KeyboardEvent.code` is the physical key — the same thing the hook
 * will be asked to match later. Capture phase, so the keys never reach the controls behind.
 */
window.addEventListener(
  'keydown',
  (e) => {
    if (!hkRecording) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.code === 'Escape') {
      stopRecording();
      setMsg(hkMsgEl, '');
      return;
    }
    // Auto-repeat while a chord is being held would add the same key again and again.
    if (e.repeat) return;

    const name = keyNameFromCode(e.code);
    if (!name) {
      setMsg(hkMsgEl, 'Bu tugmani bog‘lab bo‘lmaydi', 'warn');
      return;
    }
    if (!hkPressed.includes(name)) hkPressed.push(name);
    hkHeld.add(name);
    renderHotkeyEditor();
  },
  true
);

window.addEventListener(
  'keyup',
  (e) => {
    if (!hkRecording) return;
    e.preventDefault();
    e.stopPropagation();

    hkHeld.delete(keyNameFromCode(e.code));
    // The chord is finished when the last key comes back up — that is what "press this
    // combination" means, and waiting for it is what lets Ctrl, then Shift, then Space be
    // read as one chord rather than three.
    if (hkHeld.size > 0) return;

    const target = hkRecording;
    const chord = sortChord(hkPressed);
    const problem = chordProblem(chord);
    if (problem) {
      hkPressed = [];
      setMsg(hkMsgEl, problem, 'err');
      renderHotkeyEditor();
      return;
    }

    stopRecording();
    void commitChord(target, chord);
  },
  true
);

async function commitChord(key: keyof HotkeySettings, chord: Chord): Promise<void> {
  const hotkeys: HotkeySettings = { ...settings.hotkeys, [key]: chord };
  // The two must not be the same chord: whichever matched first would make the other
  // unreachable, and the user would be left pressing keys that do nothing.
  if (
    hotkeys.pushToTalk.length &&
    hotkeys.handsFree.length &&
    chordEquals(hotkeys.pushToTalk, hotkeys.handsFree)
  ) {
    setMsg(hkMsgEl, 'Ikkala amal uchun bir xil tugmalar bo‘lmaydi', 'err');
    renderHotkeyEditor();
    return;
  }

  if (!(await patch({ hotkeys }))) return;
  const warning = key === 'pushToTalk' ? pushToTalkWarning(chord) : '';
  setMsg(hkMsgEl, warning || 'Saqlandi', warning ? 'warn' : 'ok');
  renderHotkeyEditor();
  renderHotkeyText();
  // The welcome flow's keycaps are drawn from this chord, and main is now watching a
  // different one.
  if (welcomeStep === STEP_KEYS) void enterStep(STEP_KEYS);
}

function openHotkeyEditor(): void {
  setMsg(hkMsgEl, '');
  renderHotkeyEditor();
  hotkeyModalEl.classList.remove('hidden');
}

function closeHotkeyEditor(): void {
  stopRecording();
  setMsg(hkMsgEl, '');
  hotkeyModalEl.classList.add('hidden');
}

for (const { key, edit } of HK_ROWS) {
  el<HTMLButtonElement>(edit).addEventListener('click', () => startRecording(key));
}

el<HTMLButtonElement>('hkClearFree').addEventListener('click', () => void commitChord('handsFree', []));
el<HTMLButtonElement>('hkDone').addEventListener('click', closeHotkeyEditor);
el<HTMLElement>('hkScrim').addEventListener('click', closeHotkeyEditor);
el<HTMLButtonElement>('openHotkeys').addEventListener('click', openHotkeyEditor);

el<HTMLButtonElement>('hkReset').addEventListener('click', async () => {
  if (!(await patch({ hotkeys: DEFAULT_HOTKEYS }))) return;
  setMsg(hkMsgEl, 'Standart holatga qaytarildi', 'ok');
  renderHotkeyEditor();
  renderHotkeyText();
  if (welcomeStep === STEP_KEYS) void enterStep(STEP_KEYS);
});

// ----------------------------------------------------------------- welcome

/**
 * Setup, as a wizard rather than a scrolling page.
 *
 * The order is the order the app needs things in, and the first step is the one that made
 * this a wizard at all: the app cannot transcribe a single word without an account, so
 * "Boshladik" used to finish a setup that had quietly skipped the only step that mattered.
 * One step to a screen means the button forward can refuse — and it does, on step 0, until
 * the deep link comes back from the browser.
 *
 * `Reja` is second for a reason that is about honesty rather than conversion: an offer to
 * pay is meaningless before there is an account to attach it to, and an imposition after the
 * user has already spent five minutes setting the thing up. Directly after sign-in is the
 * one place it is simply information. It is also the only step in the flow with *nothing*
 * to decide — the forward button reads "Bepul davom etish" and does exactly that.
 */
const WELCOME_STEPS = ['Kirish', 'Reja', 'Mikrofon', 'Til', 'Tugmalar', 'Sinov', 'Tayyor'];
const LAST_STEP = WELCOME_STEPS.length - 1;

/**
 * The steps that other code has to name.
 *
 * Named rather than written as numbers because inserting `Reja` at position 1 moved four of
 * them, and the literals were scattered across a hotkey watcher, two card buttons, a
 * textarea listener and the chord editor — every one of which would have gone on compiling
 * while pointing at the wrong screen. Step 0 stays a literal: it is the sign-in gate, and it
 * is not going to move.
 */
const STEP_PLAN = 1;
const STEP_MIC = 2;
const STEP_LANG = 3;
const STEP_KEYS = 4;
const STEP_TRY = 5;

const welcomeEl = el<HTMLElement>('welcome');
const wRailEl = el<HTMLElement>('wRail');
const wNameEl = el<HTMLInputElement>('wName');
const wMicMsgEl = el<HTMLElement>('wMicMsg');
const wMsgEl = el<HTMLElement>('wMsg');
const wTryEl = el<HTMLTextAreaElement>('wTry');
const wTryMsgEl = el<HTMLElement>('wTryMsg');
const wKeysEl = el<HTMLElement>('wKeys');
const wKeysMsgEl = el<HTMLElement>('wKeysMsg');
const wNextEl = el<HTMLButtonElement>('wNext');
const wBackEl = el<HTMLButtonElement>('wBack');
const wMeter = createMeter(el<HTMLElement>('wMeter'));

let welcomeStep = 0;
/** The furthest step reached, so the rail can offer the ones already done. */
let welcomeSeen = 0;
/** Whether the practice step has produced a real dictation yet. */
let welcomeDictated = false;

const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'uz', label: 'O‘zbekcha' },
  { value: 'ru', label: 'Ruscha' },
  { value: 'en', label: 'Inglizcha' }
];

function isWelcomeOpen(): boolean {
  return !welcomeEl.classList.contains('hidden');
}

function renderWelcomeRail(): void {
  wRailEl.replaceChildren();
  WELCOME_STEPS.forEach((label, index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = 'w-rail-sep';
      wRailEl.appendChild(sep);
    }
    const step = document.createElement('button');
    step.className = 'w-rail-step';
    if (index === welcomeStep) step.classList.add('on');
    else if (index < welcomeSeen) step.classList.add('done');
    step.innerHTML = `<i>${index + 1}</i>`;
    step.appendChild(document.createTextNode(label));
    // Only backwards, and only to a step already passed: the rail reports progress, it does
    // not let someone jump over the sign-in.
    if (index < welcomeStep) step.addEventListener('click', () => void enterStep(index));
    wRailEl.appendChild(step);
  });
}

function renderWelcomeAuth(): void {
  const signedIn = account.user !== null;
  el<HTMLElement>('wSignInRow').classList.toggle('hidden', signedIn);
  el<HTMLElement>('wSignedIn').classList.toggle('hidden', !signedIn);
  el<HTMLButtonElement>('wSignInRetry').classList.toggle('hidden', signedIn || !account.error);

  if (account.user) {
    // textContent, not innerHTML: a display name comes from Google and is arbitrary text.
    el<HTMLElement>('wSignedName').textContent = account.user.name || 'Kirdingiz';
    el<HTMLElement>('wSignedEmail').textContent = account.user.email;
  }
  if (welcomeStep === 0) renderWelcomeFoot();
}

function renderWelcomeFoot(): void {
  wBackEl.classList.toggle('hidden', welcomeStep === 0);
  // On the plan step the forward button *is* the skip — naming the free tier on it is what
  // makes "no thanks" a first-class answer rather than something you have to go looking for.
  wNextEl.textContent =
    welcomeStep === LAST_STEP
      ? 'Boshladik'
      : welcomeStep === STEP_PLAN
        ? 'Bepul davom etish'
        : 'Davom etish';

  // The one gate in the flow. Everything else has a workable default; this does not.
  const blocked = welcomeStep === 0 && account.user === null;
  wNextEl.disabled = blocked;
  setMsg(
    wMsgEl,
    blocked ? 'Davom etish uchun Google bilan kiring' : '',
    blocked ? 'warn' : ''
  );
}

async function renderDeviceList(): Promise<void> {
  const list = el<HTMLElement>('wDevices');
  const devices = await window.api.listDevices();
  list.replaceChildren();

  const rows = [
    { id: '', label: 'Avtomatik', note: 'Tizim ro‘yxatidagi birinchi mikrofon' },
    ...devices.map((device) => ({ id: device.id, label: device.label, note: '' }))
  ];

  for (const row of rows) {
    const button = document.createElement('button');
    button.className = 'w-device';
    if (row.id === settings.deviceId) button.classList.add('on');
    const name = document.createElement('b');
    name.textContent = row.label;
    button.appendChild(name);
    if (row.note) {
      const note = document.createElement('span');
      note.textContent = row.note;
      button.appendChild(note);
    }
    button.addEventListener('click', async () => {
      if (!(await patch({ deviceId: row.id }))) return;
      await renderDeviceList();
      // Reopen the microphone on the new device, so the answer to "is it this one?" is the
      // meter moving rather than another list.
      await startWelcomeMicTest();
    });
    list.appendChild(button);
  }
}

async function startWelcomeMicTest(): Promise<void> {
  setMsg(wMicMsgEl, '');
  await micTest.start(settings.deviceId, wMeter, null, wMicMsgEl);
}

function renderWelcomeLanguages(): void {
  const box = el<HTMLElement>('wLangs');
  box.replaceChildren();
  for (const language of LANGUAGES) {
    const chip = document.createElement('button');
    chip.className = 'w-chip';
    chip.textContent = language.label;
    if (language.value === settings.language) chip.classList.add('on');
    chip.addEventListener('click', async () => {
      if (!(await patch({ language: language.value }))) return;
      renderWelcomeLanguages();
      renderStyle();
    });
    box.appendChild(chip);
  }
}

/** The keycaps for the shortcut test, lit by main from the global hook. */
function renderKeycaps(down: string[] = []): void {
  const chord = settings.hotkeys.pushToTalk;
  wKeysEl.replaceChildren();
  chord.forEach((name, index) => {
    if (index > 0) {
      const plus = document.createElement('span');
      plus.className = 'kbd-plus';
      plus.textContent = '+';
      wKeysEl.appendChild(plus);
    }
    const cap = document.createElement('span');
    cap.className = down.includes(name) ? 'kbd-cap down' : 'kbd-cap';
    cap.textContent = keyLabel(name);
    wKeysEl.appendChild(cap);
  });
}

window.api.onHotkeyKeys((keys) => {
  if (!isWelcomeOpen() || welcomeStep !== STEP_KEYS) return;
  renderKeycaps(keys);
  if (keys.length === settings.hotkeys.pushToTalk.length && keys.length > 0) {
    setMsg(wKeysMsgEl, 'Ishlayapti — shu tugmalarni bosib gapirasiz', 'ok');
  }
});

/**
 * Enter a step, doing whatever that step needs and undoing whatever the last one held.
 *
 * The undo half matters more than it looks: two of the steps hold a real resource — the
 * microphone, and main's key-state reporting — and a wizard that left either running would
 * keep the mic open for the rest of the session, or keep reporting keystrokes to a window
 * that stopped drawing them.
 */
async function enterStep(index: number): Promise<void> {
  await micTest.stop();
  await window.api.watchHotkey([]);

  welcomeStep = Math.max(0, Math.min(LAST_STEP, index));
  welcomeSeen = Math.max(welcomeSeen, welcomeStep);

  for (const step of document.querySelectorAll<HTMLElement>('.w-step')) {
    step.classList.toggle('on', Number(step.dataset.step) === welcomeStep);
  }
  renderWelcomeRail();
  renderWelcomeFoot();

  if (welcomeStep === 0) renderWelcomeAuth();

  if (welcomeStep === STEP_PLAN) renderWelcomePlans();

  if (welcomeStep === STEP_MIC) {
    el<HTMLElement>('wDevicePicker').classList.add('hidden');
    await renderDeviceList();
    await startWelcomeMicTest();
  }

  if (welcomeStep === STEP_LANG) renderWelcomeLanguages();

  if (welcomeStep === STEP_KEYS) {
    setMsg(wKeysMsgEl, '');
    renderKeycaps();
    await window.api.watchHotkey(settings.hotkeys.pushToTalk);
  }

  if (welcomeStep === STEP_TRY) {
    welcomeDictated = false;
    setMsg(wTryMsgEl, '');
    wTryEl.value = '';
    wTryEl.focus();
  }

  if (welcomeStep === LAST_STEP) await renderSummary();
}

/**
 * The price on the plan step, and nothing else on it.
 *
 * Read from the snapshot the server sent rather than written into the markup, for the same
 * reason the Hisob pane does it: a price baked into a shipped HTML file is a price that goes
 * stale the day it changes, and this one is quoted next to a payment button. Until the
 * snapshot lands the card shows an em dash — an honest "we are asking" — rather than a
 * number that might be wrong.
 */
function renderWelcomePlans(): void {
  const tiyin = account.plan?.priceTiyin ?? 0;
  el<HTMLElement>('wProPrice').textContent = tiyin > 0 ? formatSom(tiyin) : '—';
}

/** What was actually chosen, in the four words each choice deserves. */
async function renderSummary(): Promise<void> {
  el<HTMLElement>('wSumAccount').textContent = account.user?.email || '—';
  // Named rather than left off, because the plan step can be passed in one click and the
  // summary is the last chance to notice that "Bepul davom etish" is what happened.
  const plan = account.plan;
  el<HTMLElement>('wSumPlan').textContent = !plan
    ? '—'
    : plan.plan === 'pro'
      ? `Pro — haftasiga ${formatCount(plan.wordLimit)} so‘z`
      : `Bepul — haftasiga ${formatCount(plan.wordLimit)} so‘z`;
  el<HTMLElement>('wSumLang').textContent =
    LANGUAGES.find((language) => language.value === settings.language)?.label ?? '—';
  el<HTMLElement>('wSumKeys').textContent = formatChord(settings.hotkeys.pushToTalk);

  // The device is stored as ffmpeg's ASCII alternative name, which is not a thing to show
  // anybody; look the friendly one back up. Cached in main, so this costs no enumeration.
  const mic = el<HTMLElement>('wSumMic');
  if (!settings.deviceId) {
    mic.textContent = 'Avtomatik';
    return;
  }
  const devices = await window.api.listDevices();
  mic.textContent = devices.find((device) => device.id === settings.deviceId)?.label ?? 'Avtomatik';
}

el<HTMLButtonElement>('wMicChange').addEventListener('click', () => {
  el<HTMLElement>('wDevicePicker').classList.toggle('hidden');
});

el<HTMLButtonElement>('wMicYes').addEventListener('click', () => void enterStep(STEP_LANG));
el<HTMLButtonElement>('wKeysYes').addEventListener('click', () => void enterStep(STEP_TRY));

el<HTMLButtonElement>('wUpgrade').addEventListener('click', async () => {
  const msg = el<HTMLElement>('wPlanMsg');
  setMsg(msg, 'To‘lov sahifasi ochilmoqda…');
  const error = await window.api.startCheckout();
  if (error) {
    setMsg(msg, error, 'err');
    return;
  }
  // The plan flips when Payme calls our server, not when the browser opens — so setup does
  // not wait for it and does not claim it happened. Carrying on to the microphone is right
  // either way: the payment finishes in a browser tab while the user keeps going here.
  setMsg(
    msg,
    'Brauzerda to‘lovni yakunlang. Sozlashni davom ettiraverasiz — reja to‘lovdan so‘ng ochiladi.',
    'ok'
  );
});

el<HTMLButtonElement>('wKeysNo').addEventListener('click', () => {
  setMsg(
    wKeysMsgEl,
    'Boshqa dastur tugmalarni ushlab turgan bo‘lishi mumkin. Boshqa juftlikni tanlab ko‘ring, ' +
      'yoki ilovani administrator sifatida ishga tushiring.',
    'warn'
  );
});

el<HTMLButtonElement>('wEditKeys').addEventListener('click', openHotkeyEditor);
el<HTMLButtonElement>('wSignInRetry').addEventListener('click', () => void beginSignIn());

wBackEl.addEventListener('click', () => void enterStep(welcomeStep - 1));

wNextEl.addEventListener('click', async () => {
  if (welcomeStep < LAST_STEP) {
    await enterStep(welcomeStep + 1);
    return;
  }
  await finishWelcome();
});

// A dictation that lands anywhere — this textarea, or another app — is proof the whole
// chain works. The textarea is only where it lands most conveniently.
wTryEl.addEventListener('input', () => {
  if (welcomeStep !== STEP_TRY || !wTryEl.value.trim() || welcomeDictated) return;
  welcomeDictated = true;
  setMsg(wTryMsgEl, 'Ishladi. Xohlagan dasturda xuddi shunday bo‘ladi.', 'ok');
});

async function finishWelcome(): Promise<void> {
  const ok = await patch({ userName: wNameEl.value, onboarded: true });
  if (!ok) {
    setMsg(wMsgEl, 'Saqlab bo‘lmadi', 'err');
    return;
  }
  await micTest.stop();
  await window.api.watchHotkey([]);
  welcomeEl.classList.add('hidden');
  renderGreeting();
  await show('dictation');
}

/** Open the flow at the beginning. Called from `start()` on a first run. */
async function openWelcome(): Promise<void> {
  welcomeEl.classList.remove('hidden');
  wNameEl.value = settings.userName;
  await enterStep(0);
}

// ------------------------------------------------------------------- start

async function start(): Promise<void> {
  settings = await window.api.getSettings();
  account = await window.api.getAccount();
  renderAccount();

  const version = `gapir me v${await window.api.getVersion()}`;
  el<HTMLElement>('helpVersion').textContent = version;
  el<HTMLElement>('modalVersion').textContent = version;
  renderGreeting();
  renderStyle();
  // Every place that names the shortcut reads it from the setting now, including this
  // window's own headings — so nothing is drawn until it has been filled in once.
  renderHotkeyText();
  renderHotkeyEditor();
  el<HTMLTextAreaElement>('scratchpadText').value = settings.scratchpad;
  setMaximized(false);

  await show(requestedSection());

  // The welcome flow sits on top of everything rather than replacing it, so closing it
  // reveals a window that is already loaded and on the right section.
  if (!settings.onboarded) await openWelcome();
}

void start();
