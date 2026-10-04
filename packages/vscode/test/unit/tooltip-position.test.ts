import { describe, expect, it } from 'vitest';
import { HOVER_DELAY, TOOLTIP_GAP, VIEWPORT_MARGIN, WARM_WINDOW, isWarm, placeTooltip } from '@hsm-web/ui/tooltip-position.js';

// the placement of the tooltips of the web app and the webview (DOM part: ui/tooltips.ts)
const viewport = { width: 800, height: 600 };
const tip = { width: 200, height: 30 };

describe('placeTooltip', () => {
    it('places tooltips of the palette right of the button, vertically centered', () => {
        const button = { left: 6, top: 100, width: 38, height: 36 };
        expect(placeTooltip(button, tip, viewport, 'right')).toEqual({ left: 44 + TOOLTIP_GAP, top: 103, placement: 'right' });
    });

    it('places tooltips of the toolbar below the item, left aligned', () => {
        const item = { left: 300, top: 8, width: 80, height: 28 };
        expect(placeTooltip(item, tip, viewport)).toEqual({ left: 300, top: 36 + TOOLTIP_GAP, placement: 'below' });
    });

    it('clamps to the right edge of the viewport', () => {
        const item = { left: 700, top: 8, width: 80, height: 28 };
        expect(placeTooltip(item, tip, viewport).left).toBe(viewport.width - tip.width - VIEWPORT_MARGIN);
    });

    it('flips to the opposite side when the preferred one has no room', () => {
        expect(placeTooltip({ left: 700, top: 100, width: 38, height: 36 }, tip, viewport, 'right').placement).toBe('left');
        expect(placeTooltip({ left: 10, top: 560, width: 80, height: 28 }, tip, viewport, 'below')).toMatchObject({ placement: 'above', top: 560 - TOOLTIP_GAP - 30 });
    });

    it('clamps vertically (a button near the bottom edge)', () => {
        const placed = placeTooltip({ left: 6, top: 580, width: 38, height: 36 }, tip, viewport, 'right');
        expect(placed.placement).toBe('right');
        expect(placed.top).toBe(viewport.height - tip.height - VIEWPORT_MARGIN);
    });

    it('keeps the preferred side (clamped) when the tooltip fits nowhere', () => {
        const placed = placeTooltip({ left: 0, top: 0, width: 100, height: 100 }, { width: 900, height: 700 }, { width: 120, height: 120 }, 'below');
        expect(placed).toEqual({ left: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN, placement: 'below' });
    });
});

describe('isWarm', () => {
    it('shows the next tooltip without delay shortly after one was hidden', () => {
        expect(HOVER_DELAY).toBeGreaterThan(0);
        expect(isWarm(1000, undefined)).toBe(false);
        expect(isWarm(1000, 1000 - WARM_WINDOW)).toBe(true);
        expect(isWarm(1000, 1000 - WARM_WINDOW - 1)).toBe(false);
    });
});
