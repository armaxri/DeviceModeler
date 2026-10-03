/**
 * Placement of the children of a container in a manual layout: pinned nodes (with a stored position)
 * stay where they were put, nodes without a stored position are placed near their position in the
 * automatic layout without overlapping the others.
 */
import type { Point } from '../diagram-model.js';
import { TOLERANCE, overlaps, separate } from './model.js';
import type { LayoutTreeNode } from './tree.js';

/** Distance kept between a newly placed node and the other nodes. */
export const NODE_SPACING = 30;

export interface PlacementRequest<T extends LayoutTreeNode> {
    /** The nodes to place (sizes already computed), in their order of the automatic layout. */
    children: readonly T[];
    /** The stored position of a node (relative to the parent), undefined if it is placed automatically. */
    stored: (node: T) => Point | undefined;
    /** The position of a node in the automatic layout (relative to the parent). */
    auto: (node: T) => Point;
    /** The top left corner of the content area of the parent (nodes are kept right of / below it). */
    left: number;
    top: number;
}

/**
 * Places the children of a container (in place): pinned nodes at their stored position – if they
 * would overlap the header of the container (e.g. a state got an entry action), all of them are shifted
 * down / right as a whole – pinned nodes overlapping each other are pushed apart, the other nodes are
 * placed at their position in the automatic layout translated like their nearest pinned sibling, or at
 * the nearest free spot. Returns the shift of the pinned nodes (undefined: none).
 */
export function placeChildren<T extends LayoutTreeNode>(request: PlacementRequest<T>): Point | undefined {
    const { left, top } = request;
    const pinned: T[] = [];
    const unpinned: T[] = [];
    for (const child of request.children) {
        const stored = request.stored(child);
        if (stored) {
            child.x = stored.x;
            child.y = stored.y;
            pinned.push(child);
        } else {
            unpinned.push(child);
        }
    }
    let shift: Point | undefined;
    if (pinned.length > 0) {
        const dx = Math.max(0, left - Math.min(...pinned.map(c => c.x)));
        const dy = Math.max(0, top - Math.min(...pinned.map(c => c.y)));
        if (dx > 0 || dy > 0) {
            shift = { x: dx, y: dy };
            for (const child of pinned) {
                child.x += dx;
                child.y += dy;
            }
        }
    }
    separate(pinned);
    const placed: T[] = [...pinned];
    for (const child of unpinned) {
        placeNew(child, pinned, placed, request.auto, left, top);
        placed.push(child);
    }
    return shift;
}

/** Places a node without stored position near its position in the automatic layout, without overlaps. */
function placeNew<T extends LayoutTreeNode>(node: T, pinned: T[], placed: T[], autoOf: (node: T) => Point, left: number, top: number): void {
    const auto = autoOf(node);
    let target = { ...auto };
    if (pinned.length > 0) {
        // keep the offset of the nearest pinned sibling (in the automatic layout)
        const distance = (n: T) => {
            const p = autoOf(n);
            return Math.hypot(p.x - auto.x, p.y - auto.y);
        };
        const nearest = pinned.reduce((a, b) => distance(a) <= distance(b) ? a : b);
        const nearestAuto = autoOf(nearest);
        target = { x: auto.x + nearest.x - nearestAuto.x, y: auto.y + nearest.y - nearestAuto.y };
    }
    target = { x: Math.max(left, target.x), y: Math.max(top, target.y) };
    const free = (x: number, y: number) => x >= left - TOLERANCE && y >= top - TOLERANCE
        && placed.every(other => !overlaps({ x, y, width: node.width, height: node.height }, other, NODE_SPACING / 2));
    if (free(target.x, target.y)) {
        node.x = target.x;
        node.y = target.y;
        return;
    }
    const gap = NODE_SPACING;
    const candidates: Point[] = [];
    for (const other of placed) {
        candidates.push(
            { x: other.x + other.width + gap, y: other.y },
            { x: other.x, y: other.y + other.height + gap },
            { x: other.x - node.width - gap, y: other.y },
            { x: other.x, y: other.y - node.height - gap },
            { x: other.x + other.width + gap, y: target.y },
            { x: target.x, y: other.y + other.height + gap }
        );
    }
    let best: Point | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
        const d = Math.hypot(candidate.x - target.x, candidate.y - target.y);
        if (d < bestDistance && free(candidate.x, candidate.y)) {
            best = candidate;
            bestDistance = d;
        }
    }
    node.x = best?.x ?? left;
    node.y = best?.y ?? Math.max(top, ...placed.map(p => p.y + p.height + gap));
}
