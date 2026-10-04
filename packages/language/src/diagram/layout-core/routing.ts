/**
 * Routes of edges through stored waypoints (`@via`): the orthogonal route is computed part by part from
 * the source through each waypoint to the target.
 */
import type { Point } from '../diagram-model.js';
import { insideRect, type Rect } from './model.js';
import { routeOrthogonal, type FixedPort } from './orthogonal-router.js';

export interface WaypointRouteRequest {
    source: Rect;
    target: Rect;
    /** The points the route passes through, in this order. */
    waypoints: readonly Point[];
    /** Nodes the route must not cross (a waypoint inside a node lets that part of the route cross it). */
    obstacles: readonly Rect[];
    /** Nodes containing an end point: their borders are crossed, running along them is penalized. */
    containers?: Rect[];
    /** Routes placed before (running on top of them is penalized). */
    placed?: Point[][];
    /** The route starts / ends in the middle of a side of the source / target. */
    sourceFixed?: boolean;
    targetFixed?: boolean;
    /** Direction (east, south, west, north) in which the route must not leave the source. */
    sourceExclude?: number;
    /** Anchored ends: the route starts / ends exactly at this point of the border of the source / target. */
    sourcePort?: FixedPort;
    targetPort?: FixedPort;
    bounds: { minX: number, minY: number, maxX: number, maxY: number };
}

/**
 * An orthogonal route from the source through the waypoints to the target (each part routed on its
 * own; it does not turn back at a waypoint). `cuts` are the indices of the waypoints in the route.
 * Undefined if a part cannot be routed.
 */
export function routeThroughWaypoints(request: WaypointRouteRequest): { points: Point[], cuts: number[] } | undefined {
    const stops: Rect[] = [request.source, ...request.waypoints.map(p => ({ x: p.x, y: p.y, width: 0, height: 0 })), request.target];
    const points: Point[] = [];
    const cuts: number[] = [];
    let exclude = request.sourceExclude;
    for (let i = 0; i + 1 < stops.length; i++) {
        const from = stops[i];
        const to = stops[i + 1];
        // a waypoint inside a vertex: that vertex is crossed
        const obstacles = request.obstacles.filter(o => ![from, to].some(r => r.width === 0 && insideRect(r, o)));
        const leg = routeOrthogonal({
            source: from, target: to, obstacles, containers: request.containers, placed: request.placed,
            sourceFixed: i > 0 || (request.sourceFixed ?? false),
            targetFixed: i + 2 < stops.length || (request.targetFixed ?? false),
            sourceExclude: exclude,
            sourcePort: i === 0 ? request.sourcePort : undefined,
            targetPort: i + 2 === stops.length ? request.targetPort : undefined,
            bounds: request.bounds
        });
        if (!leg) {
            return undefined;
        }
        if (i > 0) {
            cuts.push(points.length - 1);
        }
        points.push(...(i === 0 ? leg : leg.slice(1)));
        const a = leg[leg.length - 2];
        const b = leg[leg.length - 1];
        // the direction back to where the route arrived
        exclude = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? (b.x > a.x ? 2 : 0) : (b.y > a.y ? 3 : 1);
    }
    return { points, cuts };
}
