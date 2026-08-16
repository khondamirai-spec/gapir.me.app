// Same brand faces as the app window — the pill shows transcript text, and it must not be
// the one surface still speaking in Segoe UI. See src/renderer/fonts/fonts.css.
import '../fonts/fonts.css';
import type { AppState, OverlayStatus } from '../../shared/types';

/**
 * The pill's only job is to render whatever state main sends it. It holds no dictation
 * logic of its own — main is the single source of truth for the state machine.
 *
 * IDLE is not "hidden" here: the window stays on screen and the pill collapses to the
 * hairline bar. Whether the window is up at all is main's decision (see
 * src/main/overlay.ts).
 */

/** Eleven bars, and the same eleven become the dots of the thinking state. */
const BAR_COUNT = 11;
/** The height a bar rests at — a dot, not a bar of zero, which would vanish entirely. */
const DOT_HEIGHT = 3;
/** Ceiling for a bar, a little over half the 32px capsule; see the CSS notes. */
const MAX_BAR_HEIGHT = 18;
/** Spokes in the spinner. Twelve is the classic step count and what the reference uses. */
const SPOKE_COUNT = 12;

const SVG_NS = 'http://www.w3.org/2000/svg';

const pill = document.getElementById('pill') as HTMLDivElement;
const barsEl = document.getElementById('bars') as HTMLDivElement;
const spinner = document.getElementById('spinner') as unknown as SVGElement;
const check = document.getElementById('check') as unknown as SVGElement;
const label = document.getElementById('label') as HTMLDivElement;

/**
 * The pill's appearance has two independent inputs — the dictation state, which main owns,
 * and whether the cursor is on it, which only this renderer can see. Both are kept here and
 * the class list is rebuilt from both, because either one arriving alone used to be enough
 * to wipe the other off `pill.className`.
 */
let lastState: AppState = 'IDLE';
let hovered = false;
let hasText = false;

function applyClasses(): void {
  // `active` is the black capsule; `thinking` narrows it to the spinner alone, because the
  // meter is dropped the moment the microphone closes rather than frozen into dots.
  const classes: string[] = [];
  if (lastState === 'RECORDING' || lastState === 'TRANSCRIBING' || lastState === 'INJECTING')
    classes.push('active');
  if (lastState === 'TRANSCRIBING' || lastState === 'INJECTING') classes.push('thinking');
  if (lastState === 'DONE') classes.push('done');
  else if (lastState === 'ERROR') classes.push('error');
  if (hasText) classes.push('with-text');
  if (hovered) classes.push('hover');
  pill.className = classes.join(' ');
}

function setHovered(next: boolean): void {
  if (hovered === next) return;
  hovered = next;
  applyClasses();
}

const bars: HTMLDivElement[] = [];
for (let i = 0; i < BAR_COUNT; i++) {
  const bar = document.createElement('div');
  bar.className = 'bar';
  barsEl.appendChild(bar);
  bars.push(bar);
}

/**
 * The spinner's spokes, built here rather than written into the HTML: twelve near-identical
 * elements are noise in a template, and the CSP forbids the inline script that would be the
 * other way to generate them.
 */
for (let i = 0; i < SPOKE_COUNT; i++) {
  const spoke = document.createElementNS(SVG_NS, 'rect');
  spoke.setAttribute('x', '7.3');
  spoke.setAttribute('y', '1');
  spoke.setAttribute('width', '1.4');
  spoke.setAttribute('height', '4.2');
  spoke.setAttribute('rx', '0.7');
  spoke.setAttribute('fill', 'currentColor');
  spoke.setAttribute('transform', `rotate(${i * (360 / SPOKE_COUNT)} 8 8)`);
  // The trailing spokes fade rather than disappear; that gradient IS the sense of direction.
  spoke.setAttribute('opacity', (1 - (i / SPOKE_COUNT) * 0.88).toFixed(2));
  spinner.appendChild(spoke);
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
  const now = Date.now();
  bars.forEach((bar, i) => {
    // Centre bars react more than the outer ones — reads as a waveform, not a bar chart.
    const weight = 1 - Math.abs(i - (BAR_COUNT - 1) / 2) / BAR_COUNT;
    // A per-bar wobble, scaled by how loud it is: without it the whole row rises and falls
    // as one rigid hump, which reads as a meter. Speech makes neighbouring bars disagree.
    const wobble = Math.sin(now / 90 + i * 1.7) * 1.6 * Math.sqrt(value);
    // sqrt gives quiet speech visible movement; RMS alone barely leaves the floor.
    const height = DOT_HEIGHT + Math.sqrt(value) * 20 * weight + wobble;
    bar.style.height = `${Math.max(DOT_HEIGHT, Math.min(MAX_BAR_HEIGHT, height))}px`;
  });
}

/**
 * Put the waveform back to its resting row of dots. Only IDLE needs this now — the thinking
 * state hides the meter outright — but it still has to run, or the bars would be shown again
 * at whatever height the last loud syllable left them for the one frame before the next
 * `renderBars`, which reads as a flicker at the start of every dictation.
 */
function flattenBars(): void {
  for (const bar of bars) bar.style.height = `${DOT_HEIGHT}px`;
}

function truncate(text: string, max = 34): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function render(status: OverlayStatus): void {
  // The classes drive the pill's whole geometry; see the CSS for what each state looks like.
  lastState = status.state;

  // Recording only: the meter measures the microphone, and once the hotkey is released there
  // is nothing left to measure. The spinner says "working" on its own.
  const showBars = status.state === 'RECORDING';
  const showSpinner = status.state === 'TRANSCRIBING' || status.state === 'INJECTING';
  barsEl.classList.toggle('hidden', !showBars);
  spinner.classList.toggle('hidden', !showSpinner);
  check.classList.toggle('hidden', status.state !== 'DONE');

  switch (status.state) {
    case 'RECORDING':
      renderBars(status.level);
      // No caption: the bars are the message, and there is no room for one beside them.
      // A partial, when the Live API is on, is the exception the pill widens for.
      label.textContent = status.partial ? truncate(status.partial) : '';
      break;

    case 'TRANSCRIBING':
      label.textContent = status.partial ? truncate(status.partial) : '';
      break;

    case 'INJECTING':
      label.textContent = '';
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
      flattenBars();
      label.textContent = '';
      break;
  }

  // Only the active states widen for text; an error is already a wide pill of its own.
  hasText = label.textContent !== '' && status.state !== 'ERROR';
  applyClasses();
}

window.api.onStatus(render);

// Hover arrives over IPC rather than as a mouse event: the overlay window is click-through
// and Chromium is never handed the cursor at all, so main hit-tests it and sends the answer.
// See the hover notes in src/main/overlay.ts.
window.api.onOverlayHover(setHovered);
