/*
 * The placement of a tooltip (ui/tooltips.ts): DOM-free, so that it can be unit tested.
 */

export type TooltipPlacement = 'right' | 'below' | 'above' | 'left';

export interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface Size {
    width: number;
    height: number;
}

export interface TooltipPosition {
    left: number;
    top: number;
    placement: TooltipPlacement;
}

/** Distance between the anchor and the tooltip. */
export const TOOLTIP_GAP = 6;
/** Minimum distance between the tooltip and the edges of the viewport. */
export const VIEWPORT_MARGIN = 4;

const FALLBACKS: Record<TooltipPlacement, TooltipPlacement[]> = {
    right: ['right', 'left', 'below', 'above'],
    left: ['left', 'right', 'below', 'above'],
    below: ['below', 'above', 'right', 'left'],
    above: ['above', 'below', 'right', 'left']
};

/**
 * The position of a tooltip of the given size next to the anchor: on the preferred side if it fits
 * there, otherwise on the opposite side, otherwise on one of the other sides (or the preferred one if
 * it fits nowhere); clamped to the viewport along the side.
 */
export function placeTooltip(anchor: Box, tip: Size, viewport: Size, preferred: TooltipPlacement = 'below'): TooltipPosition {
    const fits = (placement: TooltipPlacement): boolean => {
        switch (placement) {
            case 'right': return anchor.left + anchor.width + TOOLTIP_GAP + tip.width + VIEWPORT_MARGIN <= viewport.width;
            case 'left': return anchor.left - TOOLTIP_GAP - tip.width - VIEWPORT_MARGIN >= 0;
            case 'below': return anchor.top + anchor.height + TOOLTIP_GAP + tip.height + VIEWPORT_MARGIN <= viewport.height;
            case 'above': return anchor.top - TOOLTIP_GAP - tip.height - VIEWPORT_MARGIN >= 0;
        }
    };
    const placement = FALLBACKS[preferred].find(fits) ?? preferred;
    let left: number;
    let top: number;
    switch (placement) {
        case 'right':
            left = anchor.left + anchor.width + TOOLTIP_GAP;
            top = anchor.top + (anchor.height - tip.height) / 2;
            break;
        case 'left':
            left = anchor.left - TOOLTIP_GAP - tip.width;
            top = anchor.top + (anchor.height - tip.height) / 2;
            break;
        case 'below':
            left = anchor.left;
            top = anchor.top + anchor.height + TOOLTIP_GAP;
            break;
        case 'above':
            left = anchor.left;
            top = anchor.top - TOOLTIP_GAP - tip.height;
            break;
    }
    return { left: Math.round(clamp(left, tip.width, viewport.width)), top: Math.round(clamp(top, tip.height, viewport.height)), placement };
}

function clamp(start: number, size: number, available: number): number {
    return Math.max(VIEWPORT_MARGIN, Math.min(start, available - size - VIEWPORT_MARGIN));
}

/**
 * Whether a tooltip shows without the hover delay: shortly after another tooltip was hidden because the
 * pointer moved on (like the hovers of VS Code when moving along a toolbar).
 */
export function isWarm(now: number, lastHidden: number | undefined, window = WARM_WINDOW): boolean {
    return lastHidden !== undefined && now - lastHidden <= window;
}

/** The hover delay of a tooltip (ms). */
export const HOVER_DELAY = 500;
/** How long after a tooltip was hidden the next one shows without delay (ms). */
export const WARM_WINDOW = 600;
