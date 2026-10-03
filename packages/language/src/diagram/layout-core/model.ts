/**
 * The data model of manual ("hand-arranged") diagram layouts shared by the state machine diagrams
 * (manual-layout.ts) and the structure diagrams (ibd-manual-layout.ts), and the geometry helpers both
 * layout engines use. See docs/architecture.md (Manual layout: shared core) for the split between the
 * shared core and the diagram specific parts.
 *
 * A manual layout maps diagram ids to stored positions: nodes (position relative to their parent node,
 * optional explicit size) and edges (waypoints relative to the edge's frame, i.e. the innermost node
 * containing both ends; an optional label offset). It is read from and written to layout annotations
 * in the model text (`@at`, `@size`, `@via`, …, see annotation-edits.ts); a model without layout
 * annotations is laid out automatically.
 */
import type { LayoutDirection, Point } from '../diagram-model.js';

export const MANUAL_LAYOUT_VERSION = 1;

export type LayoutMode = 'auto' | 'manual';

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** A stored node: position relative to the parent node, optional explicit (minimum) size. */
export interface BaseNodeLayout {
    x: number;
    y: number;
    /** Explicit size (resized by the user or imported); the node is never smaller than its content. */
    width?: number;
    height?: number;
}

/** A stored edge. */
export interface BaseEdgeLayout {
    /** Waypoints in the coordinate system of the edge's frame node (see {@link LayoutTree.frameOf}). */
    bends?: Point[];
    /** Offset of the label from its computed position. */
    label?: Point;
}

export interface BaseManualLayout<N extends BaseNodeLayout = BaseNodeLayout, E extends BaseEdgeLayout = BaseEdgeLayout> {
    version: number;
    mode: LayoutMode;
    /** Layout direction used to place new elements (default: the direction of the layout options). */
    direction?: LayoutDirection;
    nodes: Record<string, N>;
    edges: Record<string, E>;
}

export function cloneLayout<L extends BaseManualLayout>(layout: L): L {
    return JSON.parse(JSON.stringify(layout)) as L;
}

// ---------------------------------------------------------------------------------------------
// Geometry

/** Tolerance of position comparisons (px). */
export const TOLERANCE = 0.5;

export function insideRect(p: Point, rect: Rect): boolean {
    return p.x > rect.x && p.x < rect.x + rect.width && p.y > rect.y && p.y < rect.y + rect.height;
}

export function center(rect: Rect): Point {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function overlaps(a: Rect, b: Rect, margin: number): boolean {
    return a.x < b.x + b.width + margin && b.x < a.x + a.width + margin
        && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;
}

/** Whether two rectangles differ in position or size (more than {@link TOLERANCE}). */
export function sameRect(a: Rect, b: Rect, dx = 0, dy = 0): boolean {
    return Math.abs(a.x - b.x - dx) <= TOLERANCE && Math.abs(a.y - b.y - dy) <= TOLERANCE
        && Math.abs(a.width - b.width) <= TOLERANCE && Math.abs(a.height - b.height) <= TOLERANCE;
}

/**
 * Pinned nodes must not overlap (they may have grown since the layout was stored, e.g. because of a
 * longer text, or the layout was imported from a tool with other fonts): overlapping nodes are pushed
 * to the right or down, whichever is shorter.
 */
export function separate(nodes: Rect[], gap = 20): void {
    for (let iteration = 0; iteration < 100; iteration++) {
        let changed = false;
        const sorted = [...nodes].sort((a, b) => a.x - b.x || a.y - b.y);
        for (let i = 0; i < sorted.length; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
                const a = sorted[i];
                const b = sorted[j];
                if (!overlaps(a, b, 0)) {
                    continue;
                }
                const dx = a.x + a.width + gap - b.x;
                const dy = a.y + a.height + gap - b.y;
                if (dx <= dy || b.y < a.y) {
                    b.x += dx;
                } else {
                    b.y += dy;
                }
                changed = true;
            }
        }
        if (!changed) {
            return;
        }
    }
}

/** A side of a rectangular node (as in ELK: west = left, …). */
export type NodeSide = 'WEST' | 'EAST' | 'NORTH' | 'SOUTH';

/**
 * The side of the rectangle nearest to the point and the offset of the point along it (from the top /
 * left corner), kept `inset` away from the corners: where a port dragged to the point is placed.
 */
export function borderPlacement(rect: Rect, point: Point, inset = 0): { side: NodeSide, offset: number } {
    const distances: Array<[NodeSide, number]> = [
        ['WEST', Math.abs(point.x - rect.x)],
        ['EAST', Math.abs(point.x - rect.x - rect.width)],
        ['NORTH', Math.abs(point.y - rect.y)],
        ['SOUTH', Math.abs(point.y - rect.y - rect.height)]
    ];
    const side = distances.reduce((a, b) => b[1] < a[1] ? b : a)[0];
    const vertical = side === 'WEST' || side === 'EAST';
    const length = vertical ? rect.height : rect.width;
    const along = vertical ? point.y - rect.y : point.x - rect.x;
    const offset = Math.max(Math.min(inset, length / 2), Math.min(length - Math.min(inset, length / 2), along));
    return { side, offset };
}
