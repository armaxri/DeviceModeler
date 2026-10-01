/**
 * Orthogonal routing of transitions around obstacles (used by the manual layout, where the vertices are
 * placed by hand and the routes of the automatic layout no longer fit).
 *
 * A route leaves the source at the middle of one of its sides and enters the target at the middle of one
 * of its sides. In between it runs on a sparse grid made of the lines along the (inflated) borders of the
 * obstacles and the channels between them; the shortest path with few bends is searched (Dijkstra over
 * grid point and direction). Segments of routes placed before are penalized, so that routes do not run on
 * top of each other. Afterwards the ends of several routes at the same side of a vertex are spread along
 * the side ({@link distributePorts}).
 */
import type { DiagramNodeKind, Point } from './diagram-model.js';

export interface RouterRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface OrthogonalRouteRequest {
    source: RouterRect;
    target: RouterRect;
    /** The routes start / end in the middle of the sides of the source / target (round shapes). */
    sourceFixed?: boolean;
    targetFixed?: boolean;
    /** Vertices the route must not cross (without the source and the target). */
    obstacles: RouterRect[];
    /** The area the route must stay in. */
    bounds: { minX: number, minY: number, maxX: number, maxY: number };
    /** Routes placed before (running on top of them is penalized). */
    placed?: Point[][];
    /**
     * States containing the source or the target: the route crosses their borders, running along them
     * is penalized.
     */
    containers?: RouterRect[];
}

/** Distance of the routes from the vertices. */
const MARGIN = 12;
/** Cost of a bend (in units of length). */
const BEND_COST = 40;
/** Additional cost per unit of length of running on top of another route. */
const OVERLAP_COST = 2;
/** Additional cost per unit of length of running along the border of a containing state. */
const BORDER_COST = 4;

/** Directions: east, south, west, north. */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

interface Port {
    /** On the border of the vertex. */
    border: Point;
    /** In front of the border (the first / last grid point of the route). */
    stub: Point;
    /** Direction away from the vertex. */
    dir: number;
}

function ports(rect: RouterRect, margin: number, other: RouterRect, fixed: boolean): Port[] {
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    const port = (x: number, y: number, dir: number): Port => ({
        border: { x, y }, stub: { x: x + DX[dir] * margin, y: y + DY[dir] * margin }, dir
    });
    const xs = [rect.x + rect.width / 2];
    const ys = [rect.y + rect.height / 2];
    if (!fixed) {
        // aligned with the middle of the other vertex: allows a straight line
        const ox = other.x + other.width / 2;
        const oy = other.y + other.height / 2;
        if (ox > rect.x + 4 && ox < right - 4) {
            xs.push(ox);
        }
        if (oy > rect.y + 4 && oy < bottom - 4) {
            ys.push(oy);
        }
    }
    return [
        ...ys.map(y => port(right, y, 0)),
        ...xs.map(x => port(x, bottom, 1)),
        ...ys.map(y => port(rect.x, y, 2)),
        ...xs.map(x => port(x, rect.y, 3))
    ];
}

/**
 * An orthogonal route from the border of the source to the border of the target which does not cross the
 * obstacles (undefined if there is none, e.g. if the vertices are too close to each other).
 */
export function routeOrthogonal(request: OrthogonalRouteRequest): Point[] | undefined {
    return route(request, MARGIN) ?? route(request, MARGIN / 2);
}

function route(request: OrthogonalRouteRequest, margin: number): Point[] | undefined {
    const { source, target, bounds } = request;
    const blockers = [...request.obstacles, source, target].map(r => ({
        x1: r.x - margin + 0.5, y1: r.y - margin + 0.5, x2: r.x + r.width + margin - 0.5, y2: r.y + r.height + margin - 0.5
    }));
    const inside = (p: Point) => p.x >= bounds.minX - 0.01 && p.x <= bounds.maxX + 0.01 && p.y >= bounds.minY - 0.01 && p.y <= bounds.maxY + 0.01;
    const blockedPoint = (p: Point) => blockers.some(b => p.x > b.x1 && p.x < b.x2 && p.y > b.y1 && p.y < b.y2);
    const sourcePorts = ports(source, margin, target, request.sourceFixed ?? false).filter(p => inside(p.stub) && !blockedPoint(p.stub));
    const targetPorts = ports(target, margin, source, request.targetFixed ?? false).filter(p => inside(p.stub) && !blockedPoint(p.stub));
    if (sourcePorts.length === 0 || targetPorts.length === 0) {
        return undefined;
    }

    // grid lines: borders of the inflated obstacles, the channels between them and the ports
    const lines = (values: number[], min: number, max: number): number[] => {
        const sorted = [...new Set(values.filter(v => v >= min - 0.01 && v <= max + 0.01).map(v => Math.round(v * 100) / 100))].sort((a, b) => a - b);
        const result = [...sorted];
        for (let i = 0; i + 1 < sorted.length; i++) {
            result.push((sorted[i] + sorted[i + 1]) / 2);
        }
        return [...new Set(result)].sort((a, b) => a - b);
    };
    const rects = [...request.obstacles, source, target, ...(request.containers ?? [])];
    const xs = lines([bounds.minX, bounds.maxX, ...rects.flatMap(r => [r.x - margin, r.x + r.width + margin]),
        ...[...sourcePorts, ...targetPorts].map(p => p.stub.x)], bounds.minX, bounds.maxX);
    const ys = lines([bounds.minY, bounds.maxY, ...rects.flatMap(r => [r.y - margin, r.y + r.height + margin]),
        ...[...sourcePorts, ...targetPorts].map(p => p.stub.y)], bounds.minY, bounds.maxY);
    const nx = xs.length;
    const ny = ys.length;
    const index = (xi: number, yi: number) => yi * nx + xi;

    // free segments between neighboring grid points and their overlap with placed routes
    const hFree = new Uint8Array(nx * ny);
    const vFree = new Uint8Array(nx * ny);
    const hOverlap = new Float64Array(nx * ny);
    const vOverlap = new Float64Array(nx * ny);
    const placed = (request.placed ?? []).flatMap(points => points.slice(1).map((p, i) => ({ a: points[i], b: p })));
    // the borders of the containing states (as segments; running close to them counts as overlap)
    const borders = (request.containers ?? []).flatMap(r => {
        const corners = [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }];
        return corners.map((a, i) => ({ a, b: corners[(i + 1) % 4] }));
    });
    for (let yi = 0; yi < ny; yi++) {
        for (let xi = 0; xi < nx; xi++) {
            const x = xs[xi];
            const y = ys[yi];
            if (xi + 1 < nx) {
                const x2 = xs[xi + 1];
                hFree[index(xi, yi)] = blockers.some(b => y > b.y1 && y < b.y2 && x2 > b.x1 && x < b.x2) ? 0 : 1;
                hOverlap[index(xi, yi)] = overlapLength(placed, y, x, x2, true, 1) * OVERLAP_COST + overlapLength(borders, y, x, x2, true, margin) * BORDER_COST;
            }
            if (yi + 1 < ny) {
                const y2 = ys[yi + 1];
                vFree[index(xi, yi)] = blockers.some(b => x > b.x1 && x < b.x2 && y2 > b.y1 && y < b.y2) ? 0 : 1;
                vOverlap[index(xi, yi)] = overlapLength(placed, x, y, y2, false, 1) * OVERLAP_COST + overlapLength(borders, x, y, y2, false, margin) * BORDER_COST;
            }
        }
    }

    const find = (values: number[], v: number) => values.findIndex(value => Math.abs(value - Math.round(v * 100) / 100) < 0.01);
    // Dijkstra over (grid point, direction of arrival)
    const count = nx * ny * 4;
    const cost = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
    const previous = new Int32Array(count).fill(-1);
    const heap = new MinHeap();
    for (const port of sourcePorts) {
        const xi = find(xs, port.stub.x);
        const yi = find(ys, port.stub.y);
        if (xi < 0 || yi < 0) {
            continue;
        }
        const state = index(xi, yi) * 4 + port.dir;
        cost[state] = 0;
        heap.push(state, 0);
    }
    const goals = new Map<number, Port>();
    for (const port of targetPorts) {
        const xi = find(xs, port.stub.x);
        const yi = find(ys, port.stub.y);
        if (xi >= 0 && yi >= 0) {
            goals.set(index(xi, yi), port);
        }
    }
    let best: { state: number, cost: number, port: Port } | undefined;
    while (heap.size > 0) {
        const { item: state, priority } = heap.pop();
        if (priority > cost[state] || (best && priority >= best.cost)) {
            if (best && priority >= best.cost) {
                break;
            }
            continue;
        }
        const point = Math.floor(state / 4);
        const dir = state % 4;
        const goal = goals.get(point);
        if (goal) {
            // the route must enter the target against the direction of the port
            const inward = (goal.dir + 2) % 4;
            if (dir !== goal.dir) {
                const total = priority + (dir === inward ? 0 : BEND_COST);
                if (!best || total < best.cost) {
                    best = { state, cost: total, port: goal };
                }
            }
        }
        const xi = point % nx;
        const yi = Math.floor(point / nx);
        for (let next = 0; next < 4; next++) {
            if (next === (dir + 2) % 4) {
                continue;
            }
            const nxi = xi + DX[next];
            const nyi = yi + DY[next];
            if (nxi < 0 || nyi < 0 || nxi >= nx || nyi >= ny) {
                continue;
            }
            let free: number;
            let length: number;
            let overlap: number;
            if (DY[next] === 0) {
                const segment = index(Math.min(xi, nxi), yi);
                free = hFree[segment];
                overlap = hOverlap[segment];
                length = Math.abs(xs[nxi] - xs[xi]);
            } else {
                const segment = index(xi, Math.min(yi, nyi));
                free = vFree[segment];
                overlap = vOverlap[segment];
                length = Math.abs(ys[nyi] - ys[yi]);
            }
            if (!free) {
                continue;
            }
            const nextState = index(nxi, nyi) * 4 + next;
            const nextCost = priority + length + overlap + (next === dir ? 0 : BEND_COST);
            if (nextCost < cost[nextState]) {
                cost[nextState] = nextCost;
                previous[nextState] = state;
                heap.push(nextState, nextCost);
            }
        }
    }
    if (!best) {
        return undefined;
    }
    const grid: Point[] = [];
    let first = best.state;
    for (let state = best.state; state >= 0; state = previous[state]) {
        const point = Math.floor(state / 4);
        grid.unshift({ x: xs[point % nx], y: ys[Math.floor(point / nx)] });
        first = state;
    }
    const start = sourcePorts.find(p => p.dir === first % 4 && Math.abs(p.stub.x - grid[0].x) < 0.01 && Math.abs(p.stub.y - grid[0].y) < 0.01)!;
    return simplify([start.border, ...grid, best.port.border]);
}

/** Length of the part of the segment (`from` - `to` at `at`) which runs closer than `distance` along the given segments. */
function overlapLength(segments: Array<{ a: Point, b: Point }>, at: number, from: number, to: number, horizontal: boolean, distance: number): number {
    let total = 0;
    for (const { a, b } of segments) {
        if (horizontal ? Math.abs(a.y - at) < distance && Math.abs(b.y - at) < distance : Math.abs(a.x - at) < distance && Math.abs(b.x - at) < distance) {
            const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
            const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
            total += Math.max(0, Math.min(hi, to) - Math.max(lo, from));
        }
    }
    return total;
}

/** Removes duplicate points and points in the middle of straight segments. */
function simplify(points: Point[]): Point[] {
    const result: Point[] = [];
    for (const p of points) {
        const last = result[result.length - 1];
        if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) {
            continue;
        }
        const before = result[result.length - 2];
        if (before && last && ((Math.abs(before.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01)
            || (Math.abs(before.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01))) {
            result[result.length - 1] = p;
            continue;
        }
        result.push(p);
    }
    return result;
}

// ---------------------------------------------------------------------------------------------
// Ports

export interface RoutedEnd {
    /** Id of the vertex. */
    vertex: string;
    rect: RouterRect;
    kind: DiagramNodeKind;
}

export interface OrthogonalRoute {
    points: Point[];
    source: RoutedEnd;
    target: RoutedEnd;
}

/** Vertices whose border is not straight: the routes end in the middle of the side. */
export const POINT_PORT_KINDS: ReadonlySet<DiagramNodeKind> = new Set<DiagramNodeKind>(['initial', 'final', 'choice', 'junction', 'history', 'deephistory', 'entry', 'exit']);

/**
 * Spreads the ends of several routes at the same side of a vertex along the side (ordered by the
 * direction they come from, so that they do not cross). The routes are modified in place.
 */
export function distributePorts(routes: OrthogonalRoute[]): void {
    const groups = new Map<string, Array<{ route: OrthogonalRoute, atStart: boolean, side: number }>>();
    for (const route of routes) {
        for (const atStart of [true, false]) {
            const end = atStart ? route.source : route.target;
            if (POINT_PORT_KINDS.has(end.kind) || route.points.length < 2) {
                continue;
            }
            const side = sideOf(end.rect, atStart ? route.points[0] : route.points[route.points.length - 1]);
            if (side >= 0) {
                const key = `${end.vertex}\n${side}`;
                groups.set(key, [...(groups.get(key) ?? []), { route, atStart, side }]);
            }
        }
    }
    for (const group of groups.values()) {
        if (group.length < 2) {
            continue;
        }
        const horizontalSide = group[0].side === 1 || group[0].side === 3;
        const rect = (group[0].atStart ? group[0].route.source : group[0].route.target).rect;
        // order by the position of the route after its first segment
        const along = ({ route, atStart }: { route: OrthogonalRoute, atStart: boolean }) => {
            const points = atStart ? route.points : [...route.points].reverse();
            const p = points[Math.min(2, points.length - 1)];
            return horizontalSide ? p.x : p.y;
        };
        const sorted = group.map(end => ({ ...end, along: along(end) })).sort((a, b) => a.along - b.along);
        const from = horizontalSide ? rect.x : rect.y;
        const length = horizontalSide ? rect.width : rect.height;
        const gap = length / (sorted.length + 1);
        let positions = sorted.map((_, i) => from + gap * (i + 1));
        // a straight route to a vertex with a fixed port (e.g. a final state) keeps its position, the
        // others are placed around it (a jog in the straight line would look odd)
        const straight = sorted.findIndex(({ route, atStart }) => route.points.length === 2 && POINT_PORT_KINDS.has((atStart ? route.target : route.source).kind));
        if (straight >= 0) {
            const center = sorted[straight].route.points[0][horizontalSide ? 'x' : 'y'];
            const around = sorted.map((_, i) => center + (i - straight) * gap);
            if (around.every(p => p >= from + 4 && p <= from + length - 4)) {
                positions = around;
            }
        }
        sorted.forEach(({ route, atStart }, i) => {
            shiftEnd(route, atStart, horizontalSide ? 'x' : 'y', positions[i]);
        });
    }
}

/** The side of the rectangle the point lies on (east, south, west, north; -1: none). */
function sideOf(rect: RouterRect, p: Point): number {
    if (Math.abs(p.x - (rect.x + rect.width)) < 0.5) {
        return 0;
    }
    if (Math.abs(p.y - (rect.y + rect.height)) < 0.5) {
        return 1;
    }
    if (Math.abs(p.x - rect.x) < 0.5) {
        return 2;
    }
    if (Math.abs(p.y - rect.y) < 0.5) {
        return 3;
    }
    return -1;
}

/** Moves the first (or last) segment of the route to the given coordinate (parallel to the side). */
function shiftEnd(route: OrthogonalRoute, atStart: boolean, axis: 'x' | 'y', value: number): void {
    const points = atStart ? route.points : [...route.points].reverse();
    if (points.length === 2) {
        // straight line: a jog in the middle
        const [a, b] = points;
        const other = axis === 'x' ? 'y' : 'x';
        const middle = (a[other] + b[other]) / 2;
        const jog1 = { ...a, [axis]: value, [other]: middle } as Point;
        const jog2 = { ...b, [other]: middle } as Point;
        points.splice(1, 0, jog1, jog2);
    }
    points[0] = { ...points[0], [axis]: value };
    points[1] = { ...points[1], [axis]: value };
    route.points = simplify(atStart ? points : points.reverse());
}

// ---------------------------------------------------------------------------------------------

/** Whether the polyline crosses the rectangle. */
export function crossesRect(points: Point[], rect: RouterRect): boolean {
    for (let i = 0; i + 1 < points.length; i++) {
        if (segmentCrossesRect(points[i], points[i + 1], rect)) {
            return true;
        }
    }
    return false;
}

/** Liang-Barsky clipping of the segment against the interior of the rectangle. */
function segmentCrossesRect(a: Point, b: Point, rect: RouterRect): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;
    const checks: Array<[number, number]> = [
        [-dx, a.x - rect.x], [dx, rect.x + rect.width - a.x],
        [-dy, a.y - rect.y], [dy, rect.y + rect.height - a.y]
    ];
    for (const [p, q] of checks) {
        if (Math.abs(p) < 1e-9) {
            if (q <= 0) {
                return false;
            }
            continue;
        }
        const t = q / p;
        if (p < 0) {
            t0 = Math.max(t0, t);
        } else {
            t1 = Math.min(t1, t);
        }
        if (t0 >= t1) {
            return false;
        }
    }
    return t1 - t0 > 1e-6;
}

class MinHeap {
    private readonly items: number[] = [];
    private readonly priorities: number[] = [];

    get size(): number {
        return this.items.length;
    }

    push(item: number, priority: number): void {
        this.items.push(item);
        this.priorities.push(priority);
        let i = this.items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.priorities[parent] <= this.priorities[i]) {
                break;
            }
            this.swap(i, parent);
            i = parent;
        }
    }

    pop(): { item: number, priority: number } {
        const result = { item: this.items[0], priority: this.priorities[0] };
        const lastItem = this.items.pop()!;
        const lastPriority = this.priorities.pop()!;
        if (this.items.length > 0) {
            this.items[0] = lastItem;
            this.priorities[0] = lastPriority;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let smallest = i;
                if (l < this.items.length && this.priorities[l] < this.priorities[smallest]) {
                    smallest = l;
                }
                if (r < this.items.length && this.priorities[r] < this.priorities[smallest]) {
                    smallest = r;
                }
                if (smallest === i) {
                    break;
                }
                this.swap(i, smallest);
                i = smallest;
            }
        }
        return result;
    }

    private swap(a: number, b: number): void {
        [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
        [this.priorities[a], this.priorities[b]] = [this.priorities[b], this.priorities[a]];
    }
}
