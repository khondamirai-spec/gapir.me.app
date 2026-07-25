import { describe, it, expect } from 'vitest';
import { bottomCenterBounds, _internals } from './overlay';

const { WIDTH, HEIGHT, BOTTOM_GAP } = _internals;

describe('bottomCenterBounds', () => {
  it('centres horizontally and leaves the gap above the taskbar', () => {
    // 1920x1080 with a 40px taskbar at the bottom.
    const bounds = bottomCenterBounds({ x: 0, y: 0, width: 1920, height: 1040 });

    expect(bounds.x).toBe((1920 - WIDTH) / 2);
    expect(bounds.y).toBe(1040 - HEIGHT - BOTTOM_GAP);
    expect(bounds.width).toBe(WIDTH);
    expect(bounds.height).toBe(HEIGHT);
  });

  it('respects a work area that does not start at the origin', () => {
    // A second monitor to the right, with the taskbar on the left edge of it.
    const bounds = bottomCenterBounds({ x: 1920, y: 0, width: 1280, height: 1024 });

    expect(bounds.x).toBe(1920 + (1280 - WIDTH) / 2);
    expect(bounds.y).toBe(1024 - HEIGHT - BOTTOM_GAP);
  });

  it('handles a display left of the primary, where coordinates go negative', () => {
    const bounds = bottomCenterBounds({ x: -1920, y: -120, width: 1920, height: 1080 });

    expect(bounds.x).toBe(-1920 + (1920 - WIDTH) / 2);
    expect(bounds.y).toBe(-120 + 1080 - HEIGHT - BOTTOM_GAP);
  });

  it('keeps the pill on screen when the work area is narrower than the window', () => {
    // Heavy DPI scaling on a small tablet can genuinely produce this.
    const bounds = bottomCenterBounds({ x: 0, y: 0, width: 200, height: 60 });

    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
  });

  it('always returns whole pixels — setBounds silently floors, which shifts the pill', () => {
    const bounds = bottomCenterBounds({ x: 0, y: 0, width: 1365, height: 767 });

    expect(Number.isInteger(bounds.x)).toBe(true);
    expect(Number.isInteger(bounds.y)).toBe(true);
  });
});
