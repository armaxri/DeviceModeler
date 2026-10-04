import { cloneLayout, type BaseManualLayout, type Point, type TextEdit } from 'devm-language';

/*
 * Editing of manual layouts in the diagram editor, shared by the state machine diagram
 * (DiagramController) and the structure diagram (StructureDiagram): every change starts from the
 * effective layout (all nodes pinned where they are shown; in an automatically laid out diagram the
 * captured automatic layout, so that the first change writes the whole arrangement and nothing jumps)
 * and is written back as layout annotations (one undoable text edit).
 */

/** What the {@link LayoutEditor} needs from a diagram. */
export interface LayoutEditTarget<L extends BaseManualLayout> {
    /** The effective layout of the shown diagram (manual layout), undefined if it is laid out automatically. */
    effective(): L | undefined;
    /** The automatic layout of the shown diagram as a manual layout (all nodes pinned). */
    capture(): L;
    /** Writes the layout as layout annotations (undefined removes them); resolves to whether the text changed. */
    write(layout: L | undefined): Promise<boolean>;
    /** The shown route of an edge and its waypoints (absolute), and the conversion into the coordinates of its frame. */
    edge(edgeId: string): { route: Point[], waypoints: Point[], toFrame(point: Point): Point } | undefined;
}

export class LayoutEditor<L extends BaseManualLayout> {

    constructor(private readonly target: LayoutEditTarget<L>) { }

    /** Changes the layout (`change` modifies a copy of the effective layout) and writes it. */
    change(change: (layout: L) => void): Promise<boolean> {
        const layout = cloneLayout(this.target.effective() ?? this.target.capture());
        change(layout);
        return this.target.write(layout);
    }

    /** Store positions / Re-arrange: the automatic layout is written as layout annotations. */
    arrange(): Promise<boolean> {
        return this.target.write(this.target.capture());
    }

    /** Clear positions: all layout annotations are removed. */
    reset(): Promise<boolean> {
        return this.target.write(undefined);
    }

    /** Nodes were moved (positions relative to their parents). */
    moveNodes(moves: ReadonlyArray<{ id: string, x: number, y: number }>): Promise<boolean> {
        return this.change(layout => {
            for (const move of moves) {
                layout.nodes[move.id] = { ...layout.nodes[move.id], x: move.x, y: move.y };
            }
        });
    }

    /** A node was resized (`position`: its position if it has none in the layout). */
    resize(id: string, width: number, height: number, position: Point): Promise<boolean> {
        return this.change(layout => {
            layout.nodes[id] = { ...(layout.nodes[id] ?? { x: position.x, y: position.y }), width, height };
        });
    }

    moveWaypoint(edgeId: string, index: number, point: Point): Promise<boolean> {
        const shown = this.target.edge(edgeId);
        if (!shown || index < 0 || index >= shown.waypoints.length) {
            return Promise.resolve(false);
        }
        const waypoints = [...shown.waypoints];
        waypoints[index] = point;
        return this.storeWaypoints(edgeId, waypoints, shown.toFrame);
    }

    /** Adds a waypoint (between the waypoints of the part of the route which was clicked). */
    addWaypoint(edgeId: string, point: Point): Promise<boolean> {
        const shown = this.target.edge(edgeId);
        if (!shown) {
            return Promise.resolve(false);
        }
        return this.storeWaypoints(edgeId, insertWaypoint(shown.route, shown.waypoints, point), shown.toFrame);
    }

    removeWaypoint(edgeId: string, index: number): Promise<boolean> {
        const shown = this.target.edge(edgeId);
        if (!shown || index < 0 || index >= shown.waypoints.length) {
            return Promise.resolve(false);
        }
        return this.storeWaypoints(edgeId, shown.waypoints.filter((_, i) => i !== index), shown.toFrame);
    }

    /** The label of an edge was moved by (dx, dy). */
    moveLabel(edgeId: string, dx: number, dy: number): Promise<boolean> {
        return this.change(layout => {
            const entry = { ...layout.edges[edgeId] };
            entry.label = { x: (entry.label?.x ?? 0) + dx, y: (entry.label?.y ?? 0) + dy };
            layout.edges[edgeId] = entry;
        });
    }

    private storeWaypoints(edgeId: string, waypoints: Point[], toFrame: (point: Point) => Point): Promise<boolean> {
        return this.change(layout => {
            const entry = { ...layout.edges[edgeId] };
            if (waypoints.length > 0) {
                entry.bends = waypoints.map(toFrame);
            } else {
                delete entry.bends;
            }
            // (an entry may hold more than waypoints and the label offset, e.g. the anchors of a transition)
            if (Object.values(entry).some(value => value !== undefined)) {
                layout.edges[edgeId] = entry;
            } else {
                delete layout.edges[edgeId];
            }
        });
    }
}

/**
 * The waypoints with `point` inserted between the waypoints of the part of the route closest to it (the
 * route as drawn: polyline points, or the sampled spline).
 */
export function insertWaypoint(route: readonly Point[], waypoints: readonly Point[], point: Point): Point[] {
    const at = (p: Point) => {
        let best = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i + 1 < route.length; i++) {
            const d = segmentDistance(p, route[i], route[i + 1]);
            if (d < bestDistance - 0.01) {
                best = i;
                bestDistance = d;
            }
        }
        const a = route[best];
        const b = route[best + 1];
        if (!a || !b) {
            return 0;
        }
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (length * length))) : 0;
        return best + t;
    };
    const position = at(point);
    const index = waypoints.filter(w => at(w) < position).length;
    return [...waypoints.slice(0, index), point, ...waypoints.slice(index)];
}

/** Points on a spline route (start, (control, control, end)*). */
export function sampleSpline(points: readonly Point[]): Point[] {
    const result = [points[0]];
    for (let i = 0; i + 3 < points.length; i += 3) {
        const [a, b, c, d] = [points[i], points[i + 1], points[i + 2], points[i + 3]];
        for (let k = 1; k <= 8; k++) {
            const t = k / 8;
            const u = 1 - t;
            result.push({
                x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
                y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y
            });
        }
    }
    return result;
}

/** Distance of a point from the line segment a-b. */
export function segmentDistance(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** One edit which turns `text` into `changed` (the differing middle part). */
export function replacementEdit(text: string, changed: string): TextEdit {
    let start = 0;
    while (start < text.length && start < changed.length && text[start] === changed[start]) {
        start++;
    }
    let end = 0;
    while (end < text.length - start && end < changed.length - start && text[text.length - 1 - end] === changed[changed.length - 1 - end]) {
        end++;
    }
    return { offset: start, length: text.length - start - end, text: changed.substring(start, changed.length - end) };
}
