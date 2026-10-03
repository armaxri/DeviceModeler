import type { Point } from '../diagram/diagram-model.js';
import type { IbdPort } from '../diagram/ibd-model.js';

/*
 * Geometry of the shapes of the internal block diagram (see ibd-model.ts), shared by the SVG renderer
 * (ibd-svg.ts) and the Sprotty views of the web editor, so both draw the same diagram.
 *
 * Notation of the ports (docs/structure-language.md#diagram): a small square on the border of its node,
 * **hollow** = sync port (data values), **filled** = async port (an event); an arrow in the square shows
 * the direction of the data: into the node for `in` ports, out of it for `out` ports, both ways for
 * `inout` ports. Connectors have an arrowhead at the receiving end (both ends between inout ports).
 */

/** Path of the tab of the frame (`ibd [system] Name`): a rectangle with a cut lower right corner. */
export function frameTabPath(width: number, height: number): string {
    const cut = 7;
    return `M 0,0 H ${r(width)} V ${r(height - cut)} L ${r(width - cut)},${r(height)} H 0 Z`;
}

/** The CSS classes of a port: `ibd-port flow-in|flow-out|flow-inout sync|async`. */
export function portClasses(port: Pick<IbdPort, 'direction' | 'kind'>): string[] {
    return ['ibd-port', `flow-${port.direction}`, port.kind];
}

/** Unit vectors pointing into the node from each side. */
const INTO_NODE: Record<IbdPort['side'], Point> = { WEST: { x: 1, y: 0 }, EAST: { x: -1, y: 0 }, NORTH: { x: 0, y: 1 }, SOUTH: { x: 0, y: -1 } };

/**
 * The arrow in the square of a port (relative to its top left corner) showing the direction of the data:
 * pointing into the node (`in`), out of it (`out`) or both ways (`inout`).
 */
export function portArrow(port: Pick<IbdPort, 'direction' | 'side' | 'size'>): string {
    const s = port.size;
    const base = INTO_NODE[port.side];
    const d = port.direction === 'out' ? { x: -base.x, y: -base.y } : base;
    const c = s / 2;
    const half = s * 0.3;
    const head = s * 0.22;
    const tip = { x: c + d.x * half, y: c + d.y * half };
    const tail = { x: c - d.x * half, y: c - d.y * half };
    const arrowhead = (point: Point, dir: Point) => {
        const a = { x: point.x - dir.x * head + dir.y * head, y: point.y - dir.y * head + dir.x * head };
        const b = { x: point.x - dir.x * head - dir.y * head, y: point.y - dir.y * head - dir.x * head };
        return `M ${r(a.x)},${r(a.y)} L ${r(point.x)},${r(point.y)} L ${r(b.x)},${r(b.y)}`;
    };
    const line = `M ${r(tail.x)},${r(tail.y)} L ${r(tip.x)},${r(tip.y)}`;
    return [line, arrowhead(tip, d), ...(port.direction === 'inout' ? [arrowhead(tail, { x: -d.x, y: -d.y })] : [])].join(' ');
}

/** Tooltip of a port. */
export function portTooltip(port: Pick<IbdPort, 'title' | 'direction' | 'kind'>): string {
    const what = port.kind === 'async'
        ? (port.direction === 'out' ? 'sends the event' : 'receives the event')
        : (port.direction === 'in' ? 'receives the data' : port.direction === 'out' ? 'sends the data' : 'shares the data');
    return `${port.title}\n(${what})`;
}

/**
 * The arrowheads of a connector (filled triangles, the tip on the end of the route): at the receiving
 * end (the target of the statement), at both ends between inout ports.
 */
export function connectorArrowheads(points: readonly Point[], bidirectional = false): string[] {
    const heads: string[] = [];
    const head = (tip: Point, from: Point) => {
        const dx = tip.x - from.x;
        const dy = tip.y - from.y;
        const length = Math.hypot(dx, dy);
        if (length < 0.01) {
            return;
        }
        const u = { x: dx / length, y: dy / length };
        const size = 8;
        const width = 3.5;
        const back = { x: tip.x - u.x * size, y: tip.y - u.y * size };
        heads.push(`M ${r(tip.x)},${r(tip.y)} L ${r(back.x + u.y * width)},${r(back.y - u.x * width)} L ${r(back.x - u.y * width)},${r(back.y + u.x * width)} Z`);
    };
    if (points.length >= 2) {
        head(points[points.length - 1], points[points.length - 2]);
        if (bidirectional) {
            head(points[0], points[1]);
        }
    }
    return heads;
}

/** The behavior icon (a small state machine: two states and a transition) with its left edge at `x`, centered at `y`. */
export function behaviorIconPath(x: number, y: number): { states: Array<{ x: number, y: number, width: number, height: number }>, line: string } {
    return {
        states: [{ x, y: y - 3.5, width: 6, height: 7 }, { x: x + 10, y: y - 3.5, width: 6, height: 7 }],
        line: `M ${r(x + 6)},${r(y)} H ${r(x + 10)}`
    };
}

/** The composite icon (the "rake" of SysML / UML: the element has an internal structure), its left edge at `x`, centered at `y`. */
export function compositeIconPath(x: number, y: number): string {
    const c = x + 7;
    return `M ${r(c)},${r(y - 6)} V ${r(y)} M ${r(x + 1)},${r(y + 6)} V ${r(y)} H ${r(x + 13)} V ${r(y + 6)} M ${r(c)},${r(y)} V ${r(y + 6)}`;
}

/** SVG path of an orthogonal route. */
export function ibdRoutePath(points: readonly Point[]): string {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${r(p.x)},${r(p.y)}`).join(' ');
}

function r(value: number): number {
    return Math.round(value * 100) / 100;
}
