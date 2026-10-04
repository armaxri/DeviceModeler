import { describe, expect, test } from 'vitest';
import type { DiagramEdge, EdgeRouting, Point } from '../src/diagram/diagram-model.js';
import {
    EDGE_ROUTINGS, ROUNDED_CORNER_RADIUS, arrowDirection, displayRoute, edgeCurve, elkEdgeRouting, parseEdgeRouting, roundedCorners, routeOutline,
    sampleSpline, smoothCurve
} from '../src/diagram/edge-routes.js';
import { layoutStateMachine } from '../src/diagram/layout.js';
import { parseXml, type XmlElement } from '../src/importer/xml.js';
import { renderSvg } from '../src/render/svg.js';
import { example, parse } from './helpers.js';

const close = (a: Point, b: Point, tolerance = 0.01) => Math.hypot(a.x - b.x, a.y - b.y) < tolerance;

/** The cubic Bezier segments of a route in the spline form (start, (control, control, end)*). */
function segments(points: Point[]): Point[][] {
    const result: Point[][] = [];
    for (let i = 0; i + 3 < points.length; i += 3) {
        result.push(points.slice(i, i + 4));
    }
    return result;
}

function bezier([a, b, c, d]: Point[], t: number): Point {
    const u = 1 - t;
    return {
        x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
        y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y
    };
}

/** Unit vector from a to b. */
function unit(a: Point, b: Point): Point {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
}

function expectFinite(points: Point[]): void {
    for (const p of points) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y), JSON.stringify(points)).toBe(true);
    }
}

describe('edge routing styles', () => {
    test('names and the ELK routing / drawing of the styles', () => {
        expect(EDGE_ROUTINGS.map(r => r.value)).toEqual(['ORTHOGONAL', 'ROUNDED', 'POLYLINE', 'SMOOTH', 'SPLINES']);
        expect(parseEdgeRouting('rounded')).toBe('ROUNDED');
        expect(parseEdgeRouting('Rounded-Orthogonal')).toBe('ROUNDED');
        expect(parseEdgeRouting('smooth_polyline')).toBe('SMOOTH');
        expect(parseEdgeRouting('spline')).toBe('SPLINES');
        expect(parseEdgeRouting('orthogonal')).toBe('ORTHOGONAL');
        expect(parseEdgeRouting('zigzag')).toBeUndefined();
        expect(parseEdgeRouting(undefined)).toBeUndefined();
        expect(elkEdgeRouting('ROUNDED')).toBe('ORTHOGONAL');
        expect(elkEdgeRouting('SMOOTH')).toBe('POLYLINE');
        expect(elkEdgeRouting('SPLINES')).toBe('SPLINES');
        expect(edgeCurve('ROUNDED')).toBe('rounded');
        expect(edgeCurve('SMOOTH')).toBe('smooth');
        expect(edgeCurve('POLYLINE')).toBeUndefined();
    });

    test('rounded corners are circular arcs between straight segments', () => {
        const r = 10;
        const route = roundedCorners([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }], r);
        expectFinite(route);
        // line, corner, line
        expect(route).toHaveLength(10);
        const [first, corner, last] = segments(route);
        expect(close(first[0], { x: 0, y: 0 })).toBe(true);
        expect(close(first[3], { x: 100 - r, y: 0 })).toBe(true);
        expect(close(corner[3], { x: 100, y: r })).toBe(true);
        expect(close(last[3], { x: 100, y: 80 })).toBe(true);
        // straight segments: control points on the line
        expect(first.every(p => Math.abs(p.y) < 1e-9)).toBe(true);
        expect(last.every(p => Math.abs(p.x - 100) < 1e-9)).toBe(true);
        // the corner stays (almost exactly) on the circle around (90, 10)
        for (let t = 0; t <= 1; t += 0.125) {
            const p = bezier(corner, t);
            expect(Math.abs(Math.hypot(p.x - 90, p.y - 10) - r)).toBeLessThan(0.03);
        }
        // tangent continuity at the ends of the arc
        expect(close(unit(corner[0], corner[1]), { x: 1, y: 0 })).toBe(true);
        expect(close(unit(corner[2], corner[3]), { x: 0, y: 1 })).toBe(true);
        // the arrow points along the last segment
        const arrow = arrowDirection(route);
        expect(close(unit(arrow.from, arrow.to), { x: 0, y: 1 })).toBe(true);
        expect(close(arrow.to, { x: 100, y: 80 })).toBe(true);
    });

    test('the radius is clamped to half of the shorter adjacent segment', () => {
        // a short jog of 6: both corners take at most 3
        const route = roundedCorners([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 6, y: 50 }, { x: 6, y: 100 }], 10);
        expectFinite(route);
        const [, corner1, middle, corner2] = segments(route);
        expect(close(corner1[0], { x: 0, y: 47 })).toBe(true);
        expect(close(corner1[3], { x: 3, y: 50 })).toBe(true);
        // the two corners meet in the middle of the jog
        expect(close(middle[0], middle[3])).toBe(true);
        expect(close(corner2[0], { x: 3, y: 50 })).toBe(true);
        expect(close(corner2[3], { x: 6, y: 53 })).toBe(true);
        // a short first / last segment keeps the end points
        const short = roundedCorners([{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 50, y: 4 }], 10);
        expect(close(short[0], { x: 0, y: 0 })).toBe(true);
        expect(close(short[short.length - 1], { x: 50, y: 4 })).toBe(true);
        expect(close(segments(short)[1][0], { x: 0, y: 2 })).toBe(true);
    });

    test('duplicate and collinear points, diagonal and degenerate routes', () => {
        const route = roundedCorners([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 20 }, { x: 0, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 40 }], 8);
        expectFinite(route);
        // one corner only
        expect(segments(route)).toHaveLength(3);
        // diagonal polyline (quadratic corners as in the manual layout)
        expectFinite(roundedCorners([{ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 60, y: 0 }], 10, false));
        // a U-turn
        expectFinite(roundedCorners([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 0.001 }], 10));
        // a single point
        expectFinite(roundedCorners([{ x: 5, y: 5 }, { x: 5, y: 5 }], 10));
        expectFinite(smoothCurve([{ x: 5, y: 5 }, { x: 5, y: 5 }]));
    });

    test('the smooth curve passes through all points and leaves / enters along the first / last segment', () => {
        const points = [{ x: 0, y: 0 }, { x: 40, y: 60 }, { x: 40, y: 120 }, { x: 140, y: 140 }, { x: 150, y: 220 }];
        const route = smoothCurve(points);
        expectFinite(route);
        expect(route).toHaveLength(1 + 3 * (points.length - 1));
        points.forEach((p, i) => expect(close(route[3 * i], p), `point ${i}`).toBe(true));
        expect(close(unit(route[0], route[1]), unit(points[0], points[1]))).toBe(true);
        const arrow = arrowDirection(route);
        expect(close(unit(arrow.from, arrow.to), unit(points[3], points[4]))).toBe(true);
        // smooth (C1) at the inner points: the control points on both sides are collinear with the point
        for (let i = 1; i + 1 < points.length; i++) {
            const before = unit(route[3 * i - 1], route[3 * i]);
            const after = unit(route[3 * i], route[3 * i + 1]);
            expect(close(before, after, 1e-6), `point ${i}`).toBe(true);
        }
        // no wild overshoot: the curve stays near the bounding box of the points
        for (const p of sampleSpline(route, 16)) {
            expect(p.x).toBeGreaterThan(-15);
            expect(p.x).toBeLessThan(165);
        }
        // two points: a straight line
        const line = smoothCurve([{ x: 0, y: 0 }, { x: 30, y: 0 }]);
        expect(line.every(p => Math.abs(p.y) < 1e-9)).toBe(true);
    });

    test('displayRoute draws only polyline / orthogonal routes differently', () => {
        const points = [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 50, y: 50 }];
        const edge = (routing: DiagramEdge['routing'], curve?: DiagramEdge['curve']) => ({ routing, curve, points });
        expect(displayRoute(edge('orthogonal'))).toEqual({ points, spline: false });
        expect(displayRoute(edge('polyline'))).toEqual({ points, spline: false });
        expect(displayRoute(edge('spline', 'rounded'))).toEqual({ points, spline: true });
        expect(displayRoute(edge('orthogonal', 'rounded'))).toEqual({ points: roundedCorners(points, ROUNDED_CORNER_RADIUS), spline: true });
        expect(displayRoute(edge('polyline', 'smooth'))).toEqual({ points: smoothCurve(points), spline: true });
        expect(routeOutline(edge('polyline'))).toBe(points);
        expect(routeOutline(edge('orthogonal', 'rounded')).length).toBeGreaterThan(points.length);
    });
});

function withClass(element: XmlElement, cls: string): XmlElement[] {
    const result: XmlElement[] = [];
    const visit = (e: XmlElement) => {
        if ((e.attributes['class'] ?? '').split(/\s+/).includes(cls)) {
            result.push(e);
        }
        e.children.forEach(visit);
    };
    visit(element);
    return result;
}

/** The numbers of an SVG path. */
function pathPoints(d: string): Point[] {
    const numbers = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const result: Point[] = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) {
        result.push({ x: numbers[i], y: numbers[i + 1] });
    }
    return result;
}

describe('edge routing styles: layout and SVG', () => {
    const expected: Record<EdgeRouting, { routing: DiagramEdge['routing'], curve?: DiagramEdge['curve'], commands: RegExp }> = {
        ORTHOGONAL: { routing: 'orthogonal', commands: /^M[^C]*$/ },
        ROUNDED: { routing: 'orthogonal', curve: 'rounded', commands: / C / },
        POLYLINE: { routing: 'polyline', commands: /^M[^C]*$/ },
        SMOOTH: { routing: 'polyline', curve: 'smooth', commands: / C / },
        SPLINES: { routing: 'spline', commands: / C / }
    };
    for (const { value: routing } of EDGE_ROUTINGS) {
        test(`${routing}: routes, curves and arrow heads (cd-player: history state, hierarchy, choice)`, async () => {
            const parsed = await parse(example('cd-player.hsm'));
            const { graph } = await layoutStateMachine(parsed.model, { routing });
            const shape = expected[routing];
            for (const edge of graph.edges) {
                // ELK falls back to polylines for a few spline routes
                if (routing !== 'SPLINES') {
                    expect(edge.routing, edge.id).toBe(shape.routing);
                    expect(edge.curve, edge.id).toBe(shape.curve);
                }
                if (shape.routing === 'orthogonal') {
                    for (let i = 1; i < edge.points.length; i++) {
                        const [a, b] = [edge.points[i - 1], edge.points[i]];
                        expect(Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01, edge.id).toBe(true);
                    }
                }
            }
            const root = parseXml(renderSvg(graph));
            const transitions = withClass(root, 'transition');
            expect(transitions).toHaveLength(graph.edges.length);
            transitions.forEach((g, i) => {
                const edge = graph.edges[i];
                const line = withClass(g, 'transition-line')[0].attributes['d'];
                expect(line).not.toMatch(/NaN|Infinity/);
                if (edge.routing === shape.routing) {
                    expect(line, edge.id).toMatch(shape.commands);
                }
                // the arrow head: its tip is the end of the route, its axis the direction of the last part of the drawn route
                const [tip, wing1, , wing2] = pathPoints(withClass(g, 'transition-arrow')[0].attributes['d']);
                const end = edge.points[edge.points.length - 1];
                expect(close(tip, end, 0.02), edge.id).toBe(true);
                const back = { x: (wing1.x + wing2.x) / 2, y: (wing1.y + wing2.y) / 2 };
                const route = displayRoute(edge).points;
                const { from } = arrowDirection(route);
                const axis = unit(back, tip);
                const last = unit(from, end);
                expect(axis.x * last.x + axis.y * last.y, edge.id).toBeGreaterThan(0.999);
            });
        });
    }
});
