import type { Point } from '../diagram/diagram-model.js';
import type { IbdPort } from '../diagram/ibd-model.js';

/*
 * Geometry of the shapes of the internal block diagram (see ibd-model.ts), shared by the SVG renderer
 * (ibd-svg.ts) and the Sprotty views of the web editor, so both draw the same diagram.
 *
 * Notation of the ports (docs/structure-language.md#diagram):
 * - a small square on the border of its node: **filled** = provided port, **hollow** = required port,
 * - **async** ports (events) show a chevron in the square pointing in the direction the events flow:
 *   into the node for provided ports (the component accepts the events), out of it for required ports
 *   (the component sends them); **sync** ports (data / calls) are plain squares.
 */

/** Path of the tab of the frame (`ibd [system] Name`): a rectangle with a cut lower right corner. */
export function frameTabPath(width: number, height: number): string {
    const cut = 7;
    return `M 0,0 H ${r(width)} V ${r(height - cut)} L ${r(width - cut)},${r(height)} H 0 Z`;
}

/** The CSS classes of a port: `ibd-port provided|required sync|async`. */
export function portClasses(port: Pick<IbdPort, 'direction' | 'kind'>): string[] {
    return ['ibd-port', port.direction === 'provides' ? 'provided' : 'required', port.kind];
}

/** Whether the events of a port flow into its node (provided async ports) – the direction of its chevron. */
function inward(port: Pick<IbdPort, 'direction'>): boolean {
    return port.direction === 'provides';
}

/**
 * The chevron of an async port (relative to the top left corner of the port square), pointing in the
 * direction the events flow; `undefined` for sync ports.
 */
export function portChevron(port: Pick<IbdPort, 'direction' | 'kind' | 'side' | 'size'>): string | undefined {
    if (port.kind !== 'async') {
        return undefined;
    }
    const s = port.size;
    // direction of the arrow: towards the inside of the node (inward) or away from it
    const intoNode: Record<IbdPort['side'], Point> = { WEST: { x: 1, y: 0 }, EAST: { x: -1, y: 0 }, NORTH: { x: 0, y: 1 }, SOUTH: { x: 0, y: -1 } };
    const base = intoNode[port.side];
    const d = inward(port) ? base : { x: -base.x, y: -base.y };
    const c = s / 2;
    const depth = s * 0.2;
    const spread = s * 0.27;
    // tip and the two ends of the chevron
    const tip = { x: c + d.x * depth, y: c + d.y * depth };
    const back = { x: c - d.x * depth, y: c - d.y * depth };
    const a = { x: back.x + d.y * spread, y: back.y + d.x * spread };
    const b = { x: back.x - d.y * spread, y: back.y - d.x * spread };
    return `M ${r(a.x)},${r(a.y)} L ${r(tip.x)},${r(tip.y)} L ${r(b.x)},${r(b.y)}`;
}

/** Tooltip of a port. */
export function portTooltip(port: Pick<IbdPort, 'title' | 'direction' | 'kind'>): string {
    const what = port.kind === 'async'
        ? (port.direction === 'provides' ? 'accepts the events' : 'sends the events')
        : (port.direction === 'provides' ? 'provides the data' : 'requires the data');
    return `${port.title}\n(${what})`;
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
