import type { HistoryEntry, Language, Settings, UpdateStatus } from '../../shared/types';

/**
 * The app window: your dictation history, and the settings behind it.
 *
 * Plain DOM on purpose — this is three screens with no shared state to speak of, and a
 * framework would be more machinery than the whole window is worth. Main remains the source
 * of truth for everything; this file reads, renders, and asks main to change things.
 */

type Tab = 'welcome' | 'history' | 'settings';

function el<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as unknown as T;
}

const tabsEl = el<HTMLElement>('tabs');
const versionEl = el<HTMLElement>('version');

// ---------------------------------------------------------------- level meter

const METER_BARS = 14;

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
        bar.style.height = `${on ? 4 + (i / METER_BARS) * 18 : 3}px`;
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
  active: null as { button: HTMLButtonElement; meter: Meter } | null,

  async toggle(
    deviceId: string,
    meter: Meter,
    button: HTMLButtonElement,
    msg: HTMLElement
  ): Promise<void> {
    const wasMine = this.active?.button === button;
    await this.stop();
    if (wasMine) return;

    msg.textContent = '';
    msg.className = 'msg';
    this.active = { button, meter };
    button.textContent = 'To‘xtatish';
    await window.api.startMicTest(deviceId);
  },

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active.button.textContent = 'Tekshirish';
    this.active.meter.reset();
    this.active = null;
    await window.api.stopMicTest();
  }
};

window.api.onMicLevel((level) => micTest.active?.meter.set(level));

// ---------------------------------------------------------------- shared bits

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

function setMsg(target: HTMLElement, text: string, kind: '' | 'ok' | 'warn' | 'err' = ''): void {
  target.textContent = text;
  target.className = kind ? `msg ${kind}` : 'msg';
}

async function runKeyTest(
  input: HTMLInputElement,
  button: HTMLButtonElement,
  msg: HTMLElement,
  language: Language
): Promise<boolean> {
  button.disabled = true;
  setMsg(msg, 'Tekshirilmoqda…');
  const result = await window.api.testKey(input.value, language);
  button.disabled = false;

  setMsg(
    msg,
    result.message,
    result.status === 'ok' ? 'ok' : result.status === 'invalid' ? 'err' : 'warn'
  );
  return result.status === 'ok';
}

// ---------------------------------------------------------------- history view

const searchEl = el<HTMLInputElement>('search');
const entriesEl = el<HTMLElement>('entries');
const historyPathEl = el<HTMLElement>('historyPath');
const clearAllEl = el<HTMLButtonElement>('clearAll');

let entries: HistoryEntry[] = [];
/** Ids the user has clicked open; kept across re-renders so a new dictation doesn't collapse them. */
const expanded = new Set<string>();

function relativeTime(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 45) return 'hozir';
  if (seconds < 3600) return `${Math.round(seconds / 60)} daqiqa oldin`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} soat oldin`;

  const date = new Date(ts);
  const time = date.toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `kecha ${time}`;

  return `${date.toLocaleDateString('uz-UZ')} ${time}`;
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
    empty.innerHTML = query
      ? 'Bunday matn topilmadi.'
      : 'Hali hech narsa aytilmagan.<br />Xohlagan dasturda <span class="kbd">Ctrl</span> + <span class="kbd">Caps Lock</span> bosib gapiring.';
    entriesEl.appendChild(empty);
    return;
  }

  for (const entry of visible) {
    entriesEl.appendChild(renderEntry(entry));
  }
}

function renderEntry(entry: HistoryEntry): HTMLElement {
  const card = document.createElement('div');
  card.className = 'entry';

  const head = document.createElement('div');
  head.className = 'entry-head';

  const when = document.createElement('span');
  when.className = 'entry-when';
  when.textContent = `${relativeTime(entry.createdAt)} · ${(entry.durationMs / 1000).toFixed(1)} s`;

  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.textContent = entry.language;

  const actions = document.createElement('div');
  actions.className = 'entry-actions';

  const copy = document.createElement('button');
  copy.className = 'small ghost';
  copy.textContent = 'Nusxa olish';
  copy.addEventListener('click', () => {
    void window.api.copyText(entry.text);
    copy.textContent = 'Nusxalandi ✓';
    setTimeout(() => {
      copy.textContent = 'Nusxa olish';
    }, 1200);
  });

  const remove = document.createElement('button');
  remove.className = 'danger';
  remove.textContent = 'O‘chirish';
  remove.addEventListener('click', () => void window.api.deleteHistory(entry.id));

  actions.append(copy, remove);
  head.append(when, chip, actions);

  const text = document.createElement('div');
  text.className = expanded.has(entry.id) ? 'entry-text' : 'entry-text clamped';
  text.textContent = entry.text;
  text.title = 'Ochish uchun bosing';
  text.addEventListener('click', () => {
    if (expanded.has(entry.id)) expanded.delete(entry.id);
    else expanded.add(entry.id);
    text.classList.toggle('clamped');
  });

  card.append(head, text);
  return card;
}

async function loadHistory(): Promise<void> {
  const { entries: list, filePath } = await window.api.listHistory();
  entries = list;
  historyPathEl.textContent = filePath;
  historyPathEl.title = filePath;
  renderHistory();
}

searchEl.addEventListener('input', renderHistory);

clearAllEl.addEventListener('click', () => {
  if (entries.length === 0) return;
  if (!confirm(`${entries.length} ta yozuv butunlay o‘chiriladi. Davom etamizmi?`)) return;
  void window.api.clearHistory();
});

// Main tells us whenever the log changes — including from a dictation happening right now.
window.api.onHistoryChanged(() => void loadHistory());

// ---------------------------------------------------------------- settings view

const apiKeyEl = el<HTMLInputElement>('apiKey');
const keyTestEl = el<HTMLButtonElement>('keyTest');
const keyMsgEl = el<HTMLElement>('keyMsg');
const languageEl = el<HTMLSelectElement>('language');
const deviceEl = el<HTMLSelectElement>('device');
const micTestEl = el<HTMLButtonElement>('micTest');
const micMsgEl = el<HTMLElement>('micMsg');
const launchEl = el<HTMLInputElement>('launchAtLogin');
const showIdlePillEl = el<HTMLInputElement>('showIdlePill');
const saveHistoryEl = el<HTMLInputElement>('saveHistory');
const saveEl = el<HTMLButtonElement>('save');
const saveMsgEl = el<HTMLElement>('saveMsg');
const meter = createMeter(el<HTMLElement>('meter'));

async function loadSettings(settings: Settings): Promise<void> {
  // The main process sends the key back masked; showing the mask means "already set".
  apiKeyEl.value = settings.apiKey;
  languageEl.value = settings.language;
  launchEl.checked = settings.launchAtLogin;
  showIdlePillEl.checked = settings.showIdlePill;
  saveHistoryEl.checked = settings.saveHistory;

  const count = await fillDevices(deviceEl, settings.deviceId);
  if (count === 0) setMsg(micMsgEl, 'Mikrofon topilmadi — ffmpeg o‘rnatilganini tekshiring', 'err');
}

keyTestEl.addEventListener('click', () => {
  void runKeyTest(apiKeyEl, keyTestEl, keyMsgEl, languageEl.value as Language);
});

micTestEl.addEventListener('click', () => {
  void micTest.toggle(deviceEl.value, meter, micTestEl, micMsgEl);
});

saveEl.addEventListener('click', async () => {
  saveEl.disabled = true;
  const result = await window.api.setSettings({
    apiKey: apiKeyEl.value,
    language: languageEl.value as Language,
    deviceId: deviceEl.value,
    launchAtLogin: launchEl.checked,
    showIdlePill: showIdlePillEl.checked,
    saveHistory: saveHistoryEl.checked
  });
  saveEl.disabled = false;

  if (result.ok) {
    setMsg(saveMsgEl, 'Saqlandi', 'ok');
    setTimeout(() => setMsg(saveMsgEl, ''), 2000);
  } else {
    setMsg(saveMsgEl, result.error ?? 'Saqlab bo‘lmadi', 'err');
  }
});

// ---------------------------------------------------------------- updates

const updateCheckEl = el<HTMLButtonElement>('updateCheck');
const updateInstallEl = el<HTMLButtonElement>('updateInstall');
const updateMsgEl = el<HTMLElement>('updateMsg');

updateCheckEl.addEventListener('click', () => void window.api.checkForUpdates());
updateInstallEl.addEventListener('click', () => void window.api.installUpdate());

window.api.onUpdateStatus((status: UpdateStatus) => {
  updateInstallEl.classList.toggle('hidden', status.state !== 'ready');
  updateCheckEl.disabled = status.state === 'checking' || status.state === 'downloading';

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

// ---------------------------------------------------------------- welcome view

const wKeyEl = el<HTMLInputElement>('wKey');
const wKeyTestEl = el<HTMLButtonElement>('wKeyTest');
const wKeyMsgEl = el<HTMLElement>('wKeyMsg');
const wKeyLinkEl = el<HTMLButtonElement>('wKeyLink');
const wDeviceEl = el<HTMLSelectElement>('wDevice');
const wMicTestEl = el<HTMLButtonElement>('wMicTest');
const wMicMsgEl = el<HTMLElement>('wMicMsg');
const wSaveEl = el<HTMLButtonElement>('wSave');
const wSaveMsgEl = el<HTMLElement>('wSaveMsg');
const wMeter = createMeter(el<HTMLElement>('wMeter'));

wKeyLinkEl.addEventListener('click', () => void window.api.openExternal('https://aisha.group'));

wKeyTestEl.addEventListener('click', async () => {
  const ok = await runKeyTest(wKeyEl, wKeyTestEl, wKeyMsgEl, 'uz');
  // Save a working key straight away, so step 3's "try it" box actually works before the
  // user has pressed anything else.
  if (!ok) return;
  const result = await window.api.setSettings({ apiKey: wKeyEl.value });
  if (result.ok) setMsg(wKeyMsgEl, 'Kalit ishlaydi va saqlandi ✓', 'ok');
  else setMsg(wKeyMsgEl, result.error ?? 'Kalitni saqlab bo‘lmadi', 'err');
});

wMicTestEl.addEventListener('click', () => {
  void micTest.toggle(wDeviceEl.value, wMeter, wMicTestEl, wMicMsgEl);
});

wSaveEl.addEventListener('click', async () => {
  if (!wKeyEl.value.trim()) {
    setMsg(wSaveMsgEl, 'Avval API kalitini kiriting', 'err');
    return;
  }

  wSaveEl.disabled = true;
  const result = await window.api.setSettings({
    apiKey: wKeyEl.value,
    deviceId: wDeviceEl.value
  });
  wSaveEl.disabled = false;

  if (!result.ok) {
    setMsg(wSaveMsgEl, result.error ?? 'Saqlab bo‘lmadi', 'err');
    return;
  }

  await micTest.stop();
  await start('history');
});

window.api.onMicError((message) => {
  const target = micTest.active?.button === wMicTestEl ? wMicMsgEl : micMsgEl;
  void micTest.stop();
  setMsg(target, message, 'err');
});

// ---------------------------------------------------------------- routing

const views: Record<Tab, HTMLElement> = {
  welcome: el<HTMLElement>('view-welcome'),
  history: el<HTMLElement>('view-history'),
  settings: el<HTMLElement>('view-settings')
};

async function show(tab: Tab): Promise<void> {
  // The microphone must not stay open on a screen the user has navigated away from.
  await micTest.stop();

  for (const [name, view] of Object.entries(views)) {
    view.classList.toggle('hidden', name !== tab);
  }

  // The tab bar is meaningless during the welcome flow — there is nothing to go back to.
  tabsEl.classList.toggle('hidden', tab === 'welcome');
  for (const button of tabsEl.querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset.tab === tab);
  }

  if (tab === 'history') await loadHistory();
}

for (const button of tabsEl.querySelectorAll('button')) {
  button.addEventListener('click', () => void show(button.dataset.tab as Tab));
}

window.api.onRoute((tab) => void show(tab === 'settings' ? 'settings' : 'history'));

function requestedTab(): Tab {
  return window.location.hash.replace('#', '') === 'settings' ? 'settings' : 'history';
}

/** Load everything main owns, then decide which screen the user is actually on. */
async function start(forced?: Tab): Promise<void> {
  const settings = await window.api.getSettings();

  versionEl.textContent = `v${await window.api.getVersion()}`;
  await loadSettings(settings);
  await fillDevices(wDeviceEl, settings.deviceId);

  // No key means nothing works yet, so the welcome flow outranks whichever tab was asked for.
  await show(forced ?? (settings.apiKey ? requestedTab() : 'welcome'));
}

void start();
