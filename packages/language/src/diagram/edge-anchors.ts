/**
 * Anchors of transitions: the point on the border of a state where a transition starts (`@from`) or ends
 * (`@to`), set by dragging the end of a selected transition in the diagram (see docs/manual-layout.md).
 *
 * An anchor is a side of the state and a relative position along that side in percent (0: left / top end,
 * 100: right / bottom end), so it stays on the same part of the side when the state is moved or resized.
 * States are drawn as rounded rectangles; an anchor always lies on the straight part of its side (positions
 * within a rounded corner are moved to the end of the straight part), so a route can leave the state
 * perpendicular to the side. Only states have anchors; the ends at pseudo states (initial, final, choice,
 * history, …) are computed by the layout.
 */
import type { DiagramNodeKind, Point } from './diagram-model.js';

export type AnchorSide = 'top' | 'right' | 'bottom' | 'left';

export const ANCHOR_SIDES: readonly AnchorSide[] = ['top', 'right', 'bottom', 'left'];

export interface EdgeAnchor {
    side: AnchorSide;
    /** Position along the side in percent: 0 at the left (top / bottom side) or top (left / right side) end, 100 at the other end. */
    position: number;
}

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Corner radius of the rounded rectangle of a state (web diagram and SVG renderer). */
export const STATE_CORNER_RADIUS = 12.5;

/** Whether the ends of transitions at a vertex of this kind can be anchored (states only, not pseudo states). */
export function supportsAnchors(kind: DiagramNodeKind | undefined): boolean {
    return kind === 'state';
}

export function isAnchorSide(value: unknown): value is AnchorSide {
    return typeof value === 'string' && (ANCHOR_SIDES as readonly string[]).includes(value);
}

/** The outward direction of a side as unit vector. */
export function anchorNormal(side: AnchorSide): Point {
    switch (side) {
        case 'top': return { x: 0, y: -1 };
        case 'right': return { x: 1, y: 0 };
        case 'bottom': return { x: 0, y: 1 };
        case 'left': return { x: -1, y: 0 };
    }
}

/** The direction of a side in the numbering of the orthogonal router (east 0, south 1, west 2, north 3). */
export function anchorDirection(side: AnchorSide): number {
    return { right: 0, bottom: 1, left: 2, top: 3 }[side];
}

const horizontal = (side: AnchorSide) => side === 'top' || side === 'bottom';

/** The part of a side of the given length which is straight (not in a rounded corner): from `inset` to `length - inset`. */
function straightInset(length: number, radius: number): number {
    return Math.min(radius, length / 2);
}

/**
 * The point of an anchor on the border of a rectangle (clamped to the straight part of the side of the
 * rounded rectangle with the given corner radius).
 */
export function anchorPoint(rect: Rect, anchor: EdgeAnchor, radius = STATE_CORNER_RADIUS): Point {
    const length = horizontal(anchor.side) ? rect.width : rect.height;
    const inset = straightInset(length, radius);
    const along = Math.min(Math.max(length * Math.min(Math.max(anchor.position, 0), 100) / 100, inset), length - inset);
    switch (anchor.side) {
        case 'top': return { x: rect.x + along, y: rect.y };
        case 'bottom': return { x: rect.x + along, y: rect.y + rect.height };
        case 'left': return { x: rect.x, y: rect.y + along };
        case 'right': return { x: rect.x + rect.width, y: rect.y + along };
    }
}

/**
 * The anchor nearest to a point (inside or outside the rectangle): the nearest side, the position of the
 * nearest point on it (clamped to the straight part of the side of the rounded rectangle), in percent
 * rounded to `precision` (default: integers, as written in the model).
 */
export function projectToBorder(rect: Rect, point: Point, radius = STATE_CORNER_RADIUS, precision = 1): EdgeAnchor {
    let best: { side: AnchorSide, distance: number, along: number } | undefined;
    for (const side of ANCHOR_SIDES) {
        const length = horizontal(side) ? rect.width : rect.height;
        const start = horizontal(side) ? rect.x : rect.y;
        const inset = straightInset(length, radius);
        const along = Math.min(Math.max((horizontal(side) ? point.x : point.y) - start, inset), length - inset);
        const p = anchorPoint(rect, { side, position: length > 0 ? along / length * 100 : 50 }, radius);
        const distance = Math.hypot(point.x - p.x, point.y - p.y);
        if (!best || distance < best.distance - 1e-9) {
            best = { side, distance, along };
        }
    }
    const length = horizontal(best!.side) ? rect.width : rect.height;
    const position = length > 0 ? best!.along / length * 100 : 50;
    return { side: best!.side, position: Math.round(position / precision) * precision };
}

/** The anchor of a point on the border of the rectangle (within `tolerance`), undefined if it is not on the border. */
export function anchorAt(rect: Rect, point: Point, tolerance = 0.75): EdgeAnchor | undefined {
    const all: Array<{ side: AnchorSide, distance: number }> = [
        { side: 'top', distance: Math.abs(point.y - rect.y) },
        { side: 'bottom', distance: Math.abs(point.y - rect.y - rect.height) },
        { side: 'left', distance: Math.abs(point.x - rect.x) },
        { side: 'right', distance: Math.abs(point.x - rect.x - rect.width) }
    ];
    const candidates = all.filter(c => c.distance <= tolerance
        && (horizontal(c.side) ? point.x >= rect.x - tolerance && point.x <= rect.x + rect.width + tolerance
            : point.y >= rect.y - tolerance && point.y <= rect.y + rect.height + tolerance));
    const side = candidates.sort((a, b) => a.distance - b.distance)[0]?.side;
    if (!side) {
        return undefined;
    }
    const length = horizontal(side) ? rect.width : rect.height;
    const along = horizontal(side) ? point.x - rect.x : point.y - rect.y;
    return { side, position: length > 0 ? Math.min(Math.max(along / length * 100, 0), 100) : 50 };
}

export function sameAnchor(a: EdgeAnchor | undefined, b: EdgeAnchor | undefined): boolean {
    return a === b || (!!a && !!b && a.side === b.side && Math.abs(a.position - b.position) < 1e-9);
}
