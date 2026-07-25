import type { OverlayStatus } from '../../shared/types';

/**
 * The pill's only job is to render whatever state main sends it. It holds no dictation
 * logic of its own — main is the single source of truth for the state machine.
 *
 * IDLE is not "hidden" here: the window stays on screen and the pill collapses to its
 * logo. Whether the window is up at all is main's decision (see src/main/overlay.ts).
 */

const BAR_COUNT = 5;

const pill = document.getElementById('pill') as HTMLDivElement;
const barsEl = document.getElementById('bars') as HTMLDivElement;
const spinner = document.getElementById('spinner') as HTMLDivElement;
const check = document.getElementById('check') as unknown as SVGElement;
const label = document.getElementById('label') as HTMLDivElement;

const bars: HTMLDivElement[] = [];
for (let i = 0; i < BAR_COUNT; i++) {
  const bar = document.createElement('div');
  bar.className = 'bar';
  barsEl.appendChild(bar);
  bars.push(bar);
}

/**
 * Smooth the raw RMS so the meter doesn't strobe. Attack fast (so speech feels
 * responsive) and release slow (so it decays rather than snapping to zero).
 */
let smoothed = 0;
function smooth(level: number): number {
  const coefficient = level > smoothed ? 0.55 : 0.15;
  smoothed += (level - smoothed) * coefficient;
  return smoothed;
}

function renderBars(level: number): void {
  const value = smooth(level);
  bars.forEach((bar, i) => {
    // Centre bars react more than the outer ones — reads as a waveform, not a bar chart.
    const weight = 1 - Math.abs(i - (BAR_COUNT - 1) / 2) / BAR_COUNT;
    // sqrt gives quiet speech visible movement; RMS alone barely leaves the floor.
    const height = 3 + Math.sqrt(value) * 23 * weight;
    bar.style.height = `${Math.min(26, height)}px`;
  });
}

function truncate(text: string, max = 34): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function render(status: OverlayStatus): void {
  // One class drives the pill's whole geometry; see the CSS for what each state looks like.
  pill.className = '';
  if (status.state === 'RECORDING' || status.state === 'TRANSCRIBING' || status.state === 'INJECTING')
    pill.classList.add('active');
  else if (status.state === 'DONE') pill.classList.add('done');
  else if (status.state === 'ERROR') pill.classList.add('error');

  const showBars = status.state === 'RECORDING';
  const showSpinner = status.state === 'TRANSCRIBING' || status.state === 'INJECTING';
  barsEl.classList.toggle('hidden', !showBars);
  spinner.classList.toggle('hidden', !showSpinner);
  check.classList.toggle('hidden', status.state !== 'DONE');

  switch (status.state) {
    case 'RECORDING':
      renderBars(status.level);
      label.innerHTML = status.partial
        ? `${escapeHtml(truncate(status.partial))}`
        : 'Tinglanmoqda…<span class="hint">Qo‘yib yuboring — matn joylashadi</span>';
      break;

    case 'TRANSCRIBING':
      label.innerHTML = status.partial
        ? `${escapeHtml(truncate(status.partial))}<span class="hint">Yakunlanmoqda…</span>`
        : 'Matnga o‘girilmoqda…';
      break;

    case 'INJECTING':
      label.textContent = 'Kiritilmoqda…';
      break;

    case 'DONE':
      // The tick is the whole message; a word here would only make the pill wider.
      label.textContent = '';
      break;

    case 'ERROR':
      // The red pill already signals "error"; spend the limited width on the message.
      label.textContent = status.message;
      break;

    case 'IDLE':
      smoothed = 0;
      label.textContent = '';
      break;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

window.api.onStatus(render);
