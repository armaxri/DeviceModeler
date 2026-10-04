import type { DiagramGraph, DiagramNode } from './diagram-model.js';

export interface DiagramBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * The bounds of everything drawn in the diagram (absolute coordinates): the vertices (including the
 * definition section), the name labels of entry / exit points, the routes of the transitions (for
 * splines the control points, which enclose the curve) and their labels and waypoints. Used to fit
 * the diagram to the screen: the bounds of the nodes alone miss transitions routed around the
 * outermost states and labels placed beside them. Undefined for an empty diagram.
 */
export function diagramBounds(graph: DiagramGraph): DiagramBounds | undefined {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x: number, y: number, width = 0, height = 0): void => {
        if (![x, y, width, height].every(Number.isFinite)) {
            return;
        }
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + width);
        y1 = Math.max(y1, y + height);
    };
    const addNode = (node: DiagramNode, ox: number, oy: number): void => {
        const x = ox + node.x, y = oy + node.y;
        add(x, y, node.width, node.height);
        if (node.label) {
            add(x + node.label.x, y + node.label.y, node.label.width, node.label.height);
        }
        node.children.forEach(child => addNode(child, x, y));
    };
    graph.children.forEach(node => addNode(node, 0, 0));
    for (const edge of graph.edges) {
        edge.points.forEach(p => add(p.x, p.y));
        edge.waypoints?.forEach(p => add(p.x, p.y));
        if (edge.label) {
            add(edge.label.x, edge.label.y, edge.label.width, edge.label.height);
        }
    }
    return x0 <= x1 && y0 <= y1 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined;
}
