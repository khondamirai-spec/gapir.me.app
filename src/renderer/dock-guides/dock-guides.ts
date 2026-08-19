import type { DockGuides, OverlayDock } from '../../shared/types';

/**
 * The dock guides hold no state of their own — main is dragging the pill, main knows which
 * slot the magnet has, and this only paints the answer. See src/main/dock-guides.ts.
 *
 * No fonts are imported here on purpose: there is not a word of text in this window, and
 * pulling fonts.css in would make Vite emit a second copy of every .woff2 for a window that
 * never draws a glyph.
 */

const slots: Record<OverlayDock, HTMLElement> = {
  left: document.getElementById('slot-left') as HTMLElement,
  right: document.getElementById('slot-right') as HTMLElement,
  center: document.getElementById('slot-center') as HTMLElement
};

function render({ shown, active, y }: DockGuides): void {
  document.body.classList.toggle('shown', shown);
  // The side slots follow the level the pill is being carried at, because that is where a
  // side drop now leaves it. Written as a custom property rather than a `top` so the CSS
  // keeps the half-slot correction that centres it — see the #slot-left rule.
  document.documentElement.style.setProperty('--slot-y', `${y}px`);
  for (const [dock, el] of Object.entries(slots)) {
    el.classList.toggle('active', shown && dock === active);
  }
}

window.api.onDockGuides(render);
