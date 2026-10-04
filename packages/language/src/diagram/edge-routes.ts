import type { DiagramEdge, DiagramGraph, EdgeRouting, Point } from './diagram-model.js';

/*
 * Edge routing styles and the geometry of the drawn routes. ELK computes the routes in one of its three
 * routing modes (splines, orthogonal, polyline); the styles `ROUNDED` and `SMOOTH` reuse the orthogonal
 * resp. polyline routes and only draw them differently: with rounded corners or as a smooth curve through
 * the bend points. All renderers (web diagram, SVG export, CLI) draw an edge with {@link displayRoute}.
 */

/** The edge routing styles in the order of the toolbar (from angular to curved) with their display names. */
export const EDGE_ROUTINGS: ReadonlyArray<{ value: EdgeRouting, label: string, description: string }> = [
    { value: 'ORTHOGONAL', label: 'Orthogonal', description: 'horizontal and vertical segments' },
    { value: 'ROUNDED', label: 'Rounded', description: 'orthogonal segments with rounded corners' },
    { value: 'POLYLINE', label: 'Polyline', description: 'straight segments in any direction' },
    { value: 'SMOOTH', label: 'Smooth', description: 'a smooth curve through the bend points of the polyline' },
    { value: 'SPLINES', label: 'Splines', description: 'curves computed by the layout (ELK splines)' }
];

/** Radius of the rounded corners of the `ROUNDED` style (smaller where the segments are short). */
export const ROUNDED_CORNER_RADIUS = 10;

/** How far (at least) the Bezier handles of the `SMOOTH` style may reach out sideways from a segment. */
export const SMOOTH_MAX_OFFSET = 12;

/** The routing style given by its name (case insensitive, `-` / `_` / blanks ignored; also `rounded-orthogonal`), or undefined. */
export function parseEdgeRouting(value: string | undefined): EdgeRouting | undefined {
    if (value === undefined) {
        return undefined;
    }
    const key = value.toUpperCase().replace(/[\s_-]+/g, '');
    const aliases: Record<string, EdgeRouting> = {
        SPLINE: 'SPLINES', SPLINES: 'SPLINES',
        ORTHOGONAL: 'ORTHOGONAL',
        ROUNDED: 'ROUNDED', ROUNDEDORTHOGONAL: 'ROUNDED',
        POLYLINE: 'POLYLINE',
        SMOOTH: 'SMOOTH', SMOOTHPOLYLINE: 'SMOOTH', CURVED: 'SMOOTH'
    };
    return aliases[key];
}

/** The routing mode of ELK computing the routes of a routing style. */
export function elkEdgeRouting(routing: EdgeRouting): 'SPLINES' | 'ORTHOGONAL' | 'POLYLINE' {
    switch (routing) {
        case 'ROUNDED':
            return 'ORTHOGONAL';
        case 'SMOOTH':
            return 'POLYLINE';
        default:
            return routing;
    }
}

/** How the (polyline / orthogonal) routes of a routing style are drawn. */
export function edgeCurve(routing: EdgeRouting): DiagramEdge['curve'] {
    return routing === 'ROUNDED' ? 'rounded' : routing === 'SMOOTH' ? 'smooth' : undefined;
}

/** Sets the way the routes are drawn ({@link DiagramEdge.curve}) for all edges of the graph. */
export function applyEdgeCurves(graph: DiagramGraph, routing: EdgeRouting): void {
    const curve = edgeCurve(routing);
    for (const edge of graph.edges) {
        if (curve && edge.routing !== 'spline') {
            edge.curve = curve;
        } else {
            delete edge.curve;
        }
    }
}

/**
 * The route of an edge as it is drawn: `spline` routes are cubic Bezier segments (start, (control,
 * control, end)*), otherwise the points describe a polyline.
 */
export function displayRoute(edge: Pick<DiagramEdge, 'routing' | 'points' | 'curve'>): { points: Point[], spline: boolean } {
    const points = edge.points;
    if (edge.routing === 'spline' || points.length < 2) {
        return { points, spline: edge.routing === 'spline' };
    }
    switch (edge.curve) {
        case 'rounded':
            return { points: roundedCorners(points, ROUNDED_CORNER_RADIUS), spline: true };
        case 'smooth':
            return { points: smoothCurve(points), spline: true };
        default:
            return { points, spline: false };
    }
}

/** The direction of the arrow head at the end of a drawn route (see {@link displayRoute}): from `from` to `to`. */
export function arrowDirection(points: Point[]): { from: Point, to: Point } {
    const to = points[points.length - 1];
    // the last point before the end which is not (almost) at the end: for splines the last control point
    let i = points.length - 2;
    while (i > 0 && Math.hypot(points[i].x - to.x, points[i].y - to.y) < 0.5) {
        i--;
    }
    return { from: points[Math.max(i, 0)] ?? to, to };
}

/** The points without consecutive duplicates and without points in the middle of a straight line. */
function simplify(points: Point[]): Point[] {
    const result: Point[] = [];
    for (const point of points) {
        const last = result[result.length - 1];
        if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.01) {
            continue;
        }
        const before = result[result.length - 2];
        if (before && last && turn(before, last, point) < 1e-3
            && (last.x - before.x) * (point.x - last.x) + (last.y - before.y) * (point.y - last.y) > 0) {
            // `last` lies on the straight line from `before` to `point`
            result[result.length - 1] = point;
            continue;
        }
        result.push(point);
    }
    return result;
}

/** The angle (radians, 0 … π) by which the direction changes at `b` on the way a → b → c. */
function turn(a: Point, b: Point, c: Point): number {
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const vx = c.x - b.x;
    const vy = c.y - b.y;
    return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/**
 * The polyline with rounded corners as cubic Bezier segments (start, (control, control, end)*).
 *
 * `circular` (default): the corners are circular arcs with the given radius; the radius is reduced
 * where the arc would take more than half of an adjacent segment. Otherwise each corner is a quadratic
 * curve with the corner as control point which starts and ends `radius` (at most half a segment) from the
 * corner. Straight segments are cubic segments with their control points on the line, so the direction
 * at the end (arrow head) is the direction of the last segment.
 */
export function roundedCorners(input: Point[], radius: number, circular = true): Point[] {
    const points = simplify(input);
    if (points.length < 2) {
        return [input[0], input[0], input[input.length - 1], input[input.length - 1]];
    }
    const result = [points[0]];
    const line = (to: Point) => {
        const from = result[result.length - 1];
        result.push(lerp(from, to, 1 / 3), lerp(from, to, 2 / 3), to);
    };
    for (let i = 1; i + 1 < points.length; i++) {
        const [prev, corner, next] = [points[i - 1], points[i], points[i + 1]];
        const inLength = Math.hypot(corner.x - prev.x, corner.y - prev.y);
        const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
        const angle = turn(prev, corner, next);
        let distance: number;
        let handle: number;
        if (circular) {
            // tangent length of an arc with the radius, handle length of its cubic approximation
            const half = Math.tan(angle / 2);
            distance = Math.min(angle > Math.PI - 1e-3 ? Number.POSITIVE_INFINITY : radius * half, inLength / 2, outLength / 2);
            // (a single cubic segment is a poor arc for sharp turns: there like the quadratic corner)
            handle = half > 1e-6 && angle < Math.PI * 0.75 ? distance * (4 / 3) * Math.tan(angle / 4) / half : distance * 2 / 3;
        } else {
            distance = Math.min(radius, inLength / 2, outLength / 2);
            handle = distance * 2 / 3;
        }
        const before = lerp(corner, prev, distance / inLength);
        const after = lerp(corner, next, distance / outLength);
        line(before);
        result.push(lerp(before, corner, distance > 0 ? handle / distance : 0), lerp(after, corner, distance > 0 ? handle / distance : 0), after);
    }
    line(points[points.length - 1]);
    return result;
}

/**
 * A smooth curve through the points (centripetal Catmull-Rom spline) as cubic Bezier segments
 * (start, (control, control, end)*). The curve starts and ends in the direction of the first / last
 * segment, so it leaves and enters the vertices like the polyline and the arrow head points along the
 * last segment. The centripetal parameterization does not form loops or cusps at close points; the
 * handles reach out sideways from a segment at most a quarter of the length of the neighbor segment (at
 * least {@link SMOOTH_MAX_OFFSET}), so the curve stays close to the polyline.
 */
export function smoothCurve(input: Point[]): Point[] {
    const points = simplify(input);
    if (points.length < 2) {
        return [input[0], input[0], input[input.length - 1], input[input.length - 1]];
    }
    const n = points.length;
    // phantom points beyond the ends: mirrored neighbors, so the tangents at the ends follow the segments
    const at = (i: number): Point => i < 0
        ? lerp(points[1], points[0], 2)
        : i >= n ? lerp(points[n - 2], points[n - 1], 2) : points[i];
    const result = [points[0]];
    for (let i = 0; i + 1 < n; i++) {
        const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
        const d1 = Math.sqrt(Math.hypot(p1.x - p0.x, p1.y - p0.y));
        const d2 = Math.sqrt(Math.hypot(p2.x - p1.x, p2.y - p1.y));
        const d3 = Math.sqrt(Math.hypot(p3.x - p2.x, p3.y - p2.y));
        // Bezier control points of the centripetal Catmull-Rom segment p1 → p2 (Yuksel et al.)
        const c1 = d1 > 1e-6
            ? mul(add(add(mul(p2, d1 * d1), mul(p0, -d2 * d2)), mul(p1, 2 * d1 * d1 + 3 * d1 * d2 + d2 * d2)), 1 / (3 * d1 * (d1 + d2)))
            : lerp(p1, p2, 1 / 3);
        const c2 = d3 > 1e-6
            ? mul(add(add(mul(p1, d3 * d3), mul(p3, -d2 * d2)), mul(p2, 2 * d3 * d3 + 3 * d3 * d2 + d2 * d2)), 1 / (3 * d3 * (d3 + d2)))
            : lerp(p1, p2, 2 / 3);
        // the curve stays near the segment: the handles are shortened where they point away from it, so a
        // long segment next to a short one does not bulge out over its whole length (a quarter of the
        // neighbor segment, at least SMOOTH_MAX_OFFSET)
        result.push(
            limitHandle(p1, c1, p2, Math.max(SMOOTH_MAX_OFFSET, d1 * d1 / 4)),
            limitHandle(p2, c2, p1, Math.max(SMOOTH_MAX_OFFSET, d3 * d3 / 4)),
            p2);
    }
    return result;
}

/** The control point of the segment `from` → `to` at `from`, shortened so that it is at most `max` away from the line of the segment. */
function limitHandle(from: Point, control: Point, to: Point, max: number): Point {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length === 0) {
        return control;
    }
    // distance of the control point from the line through the segment
    const offset = Math.abs((to.x - from.x) * (control.y - from.y) - (to.y - from.y) * (control.x - from.x)) / length;
    return offset > max ? lerp(from, control, max / offset) : control;
}

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Point, f: number): Point => ({ x: a.x * f, y: a.y * f });

/** Points on a route of cubic Bezier segments (start, (control, control, end)*), `steps` per segment. */
export function sampleSpline(points: Point[], steps = 8): Point[] {
    const result = [points[0]];
    for (let i = 0; i + 3 < points.length; i += 3) {
        const [a, b, c, d] = [points[i], points[i + 1], points[i + 2], points[i + 3]];
        for (let k = 1; k <= steps; k++) {
            const t = k / steps;
            const u = 1 - t;
            result.push({
                x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
                y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y
            });
        }
    }
    return result;
}

/** Points along the drawn route of an edge (the polyline itself, or samples of the curve), e.g. for hit tests. */
export function routeOutline(edge: Pick<DiagramEdge, 'routing' | 'points' | 'curve'>): Point[] {
    const route = displayRoute(edge);
    return route.spline ? sampleSpline(route.points) : route.points;
}
