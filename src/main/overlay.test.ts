import { describe, it, expect } from 'vitest';
import { bottomCenterBounds, dockBounds, dockForPosition, magnetTarget, _internals } from './overlay';

const { WIDTH, HEIGHT, SIDE_HEIGHT, BOTTOM_GAP, MAX_ASSIST_PX } = _internals;

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

describe('dockBounds', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

  it('center is exactly the bottom-centre position', () => {
    expect(dockBounds(workArea, 'center')).toEqual(bottomCenterBounds(workArea));
  });

  it('left docks flush to the left edge, vertically centred, and stands the window on end', () => {
    const bounds = dockBounds(workArea, 'left');

    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe((1040 - SIDE_HEIGHT) / 2);
    expect(bounds.width).toBe(WIDTH);
    // The pill is rotated here, and its tooltip needs the height the bottom dock spends on
    // width. See SIDE_HEIGHT.
    expect(bounds.height).toBe(SIDE_HEIGHT);
  });

  it('right docks flush to the right edge', () => {
    const bounds = dockBounds(workArea, 'right');

    expect(bounds.x).toBe(1920 - WIDTH);
    expect(bounds.y).toBe((1040 - SIDE_HEIGHT) / 2);
    expect(bounds.height).toBe(SIDE_HEIGHT);
  });

  it('respects a work area that does not start at the origin', () => {
    const bounds = dockBounds({ x: 1920, y: 200, width: 1280, height: 824 }, 'right');

    expect(bounds.x).toBe(1920 + 1280 - WIDTH);
    expect(bounds.y).toBe(200 + (824 - SIDE_HEIGHT) / 2);
  });

  it('keeps the window on screen when the work area is smaller than it', () => {
    const bounds = dockBounds({ x: 0, y: 0, width: 200, height: 60 }, 'right');

    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
    // A window taller than the display would put the rotated pill's own middle off screen.
    expect(bounds.height).toBe(60);
  });

  it('centres a side dock on the level it was dropped at, not on the screen', () => {
    // The pill sits at the middle of a side-docked window, so the window is centred on the
    // level rather than starting at it. 0.25 of a 1040px work area is 260.
    const bounds = dockBounds(workArea, 'left', 0.25);

    expect(bounds.y + bounds.height / 2).toBe(260);
  });

  it('keeps a window whose level would hang it off the work area on screen', () => {
    // Dropped hard against the top and the bottom edge: the level is honoured as far as it
    // can be, and clamped where it cannot.
    expect(dockBounds(workArea, 'left', 0).y).toBe(0);
    expect(dockBounds(workArea, 'left', 1).y).toBe(1040 - SIDE_HEIGHT);
  });

  it('ignores the level for the bottom dock, which has one place to be', () => {
    expect(dockBounds(workArea, 'center', 0.1)).toEqual(dockBounds(workArea, 'center', 0.9));
  });

  it('always returns whole pixels for the side docks too', () => {
    const bounds = dockBounds({ x: 0, y: 0, width: 1365, height: 767 }, 'left');

    expect(Number.isInteger(bounds.x)).toBe(true);
    expect(Number.isInteger(bounds.y)).toBe(true);
  });
});

describe('dockForPosition', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

  it('reads the third the window\'s middle falls in, not its left edge', () => {
    // A window whose left edge is in the left third but whose middle is not.
    expect(dockForPosition(workArea, 480)).toBe('center');
    expect(dockForPosition(workArea, 0)).toBe('left');
    expect(dockForPosition(workArea, 1920 - WIDTH)).toBe('right');
  });

  it('works on a display whose work area does not start at the origin', () => {
    const second = { x: -1920, y: 0, width: 1920, height: 1080 };

    expect(dockForPosition(second, -1920)).toBe('left');
    expect(dockForPosition(second, -1920 + 1920 - WIDTH)).toBe('right');
  });
});

describe('magnetTarget', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

  it('pulls all the way home when the pill is already in the slot', () => {
    const left = dockBounds(workArea, 'left');
    const result = magnetTarget(workArea, { x: left.x, y: left.y });

    expect(result.dock).toBe('left');
    expect(result.pull).toBe(1);
    expect(result.x).toBe(left.x);
    expect(result.y).toBe(left.y);
  });

  it('leaves the pill exactly where it is once it is out of reach', () => {
    // In the left third, at the slot's own height, but further from the edge than the
    // radius reaches — the pill has to be genuinely free out here, or the drag would feel
    // like it was being steered.
    const target = dockBounds(workArea, 'left');
    const pos = { x: target.x + 300, y: target.y };
    const result = magnetTarget(workArea, pos);

    expect(result.dock).toBe('left');
    expect(result.pull).toBe(0);
    expect(result).toMatchObject({ x: pos.x, y: pos.y });
  });

  it('pulls the pill toward the bottom slot without overshooting it', () => {
    const target = dockBounds(workArea, 'center');
    const start = { x: target.x + 80, y: target.y - 60 };
    const result = magnetTarget(workArea, start);

    expect(result.pull).toBeGreaterThan(0);
    expect(result.pull).toBeLessThan(1);
    // Strictly between where it was and where it is going, on both axes.
    expect(result.x).toBeGreaterThanOrEqual(target.x);
    expect(result.x).toBeLessThan(start.x);
    expect(result.y).toBeLessThanOrEqual(target.y);
    expect(result.y).toBeGreaterThan(start.y);
  });

  it('does not touch the height a side dock is being carried at', () => {
    // A side dock is an *edge*, not a point: the pill lands at the level it was dropped at
    // (persisted as overlayDockY), so there is no vertical target to pull toward and the
    // magnet must leave that axis strictly alone. Pinning it to the middle is what made a
    // pill dragged to the top of an edge slide back down to the centre of the screen.
    const target = dockBounds(workArea, 'left');

    for (const y of [40, 300, target.y, 700, 1000]) {
      const result = magnetTarget(workArea, { x: target.x + 40, y });

      expect(result.dock).toBe('left');
      expect(result.y).toBe(y);
      // ...while the edge itself still pulls.
      expect(result.x).toBeLessThan(target.x + 40);
    }
  });

  it('firms up monotonically as the pill closes in', () => {
    const target = dockBounds(workArea, 'center');
    const pulls = [200, 150, 100, 50, 10].map(
      (away) => magnetTarget(workArea, { x: target.x, y: target.y - away }).pull
    );

    for (let i = 1; i < pulls.length; i++) expect(pulls[i]).toBeGreaterThan(pulls[i - 1]);
  });

  it('lets the edge alone be enough to bring a side dock up to full pull', () => {
    // Flush against the left edge but 150px below the slot's height: the vertical distance
    // is discounted precisely so that "take it to the edge" is a complete gesture.
    const target = dockBounds(workArea, 'left');
    const result = magnetTarget(workArea, { x: target.x, y: target.y + 150 });

    expect(result.dock).toBe('left');
    expect(result.pull).toBeGreaterThan(0.8);
  });

  it('never moves the pill more than a nudge out from under the cursor', () => {
    // The magnet is a hint, not a delivery service: at any distance, on either axis, the
    // window it draws is within MAX_ASSIST_PX of where the hand actually put it. This is
    // the whole difference between "it leans toward the edge" and "it flew out of my hand".
    const target = dockBounds(workArea, 'left');

    for (const away of [10, 30, 60, 100, 150, 199]) {
      const pos = { x: target.x + away, y: target.y + away };
      const result = magnetTarget(workArea, pos);

      expect(Math.abs(result.x - pos.x)).toBeLessThanOrEqual(MAX_ASSIST_PX);
      expect(Math.abs(result.y - pos.y)).toBeLessThanOrEqual(MAX_ASSIST_PX);
    }
  });

  it('is symmetric between the two side docks', () => {
    const left = magnetTarget(workArea, { x: dockBounds(workArea, 'left').x + 60, y: 500 });
    const right = magnetTarget(workArea, { x: dockBounds(workArea, 'right').x - 60, y: 500 });

    expect(left.dock).toBe('left');
    expect(right.dock).toBe('right');
    expect(right.pull).toBeCloseTo(left.pull, 5);
  });
});
