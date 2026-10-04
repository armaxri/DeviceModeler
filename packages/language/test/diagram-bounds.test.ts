import { describe, expect, test } from 'vitest';
import { diagramBounds } from '../src/diagram/diagram-bounds.js';
import type { DiagramGraph, DiagramNode } from '../src/diagram/diagram-model.js';
import { layoutStateMachine } from '../src/diagram/layout.js';
import { example, parse } from './helpers.js';

function node(id: string, x: number, y: number, width: number, height: number, children: DiagramNode[] = []): DiagramNode {
    return { id, kind: 'state', x, y, width, height, children };
}

describe('diagramBounds', () => {
    test('empty diagram', () => {
        expect(diagramBounds({ id: 'm', name: 'M', width: 0, height: 0, direction: 'DOWN', children: [], edges: [] })).toBeUndefined();
    });

    test('includes nested nodes, node labels, edge routes and edge labels', () => {
        const graph: DiagramGraph = {
            id: 'm', name: 'M', width: 0, height: 0, direction: 'DOWN',
            children: [
                node('a', 20, 20, 100, 50, [{ ...node('p', 90, 10, 10, 10), kind: 'exit', label: { text: 'out', x: 12, y: 0, width: 40, height: 12 } }]),
                node('b', 20, 200, 100, 50)
            ],
            edges: [
                // routed around the states on the right, the label beyond the route
                { id: 'e', source: 'a', target: 'b', routing: 'polyline', points: [{ x: 120, y: 45 }, { x: 180, y: 45 }, { x: 180, y: 225 }, { x: 120, y: 225 }],
                    label: { text: 'cmd.open', x: 185, y: 130, width: 60, height: 14 } },
                { id: 'f', source: 'b', target: 'a', routing: 'polyline', points: [{ x: 70, y: 200 }, { x: 70, y: 70 }], waypoints: [{ x: 5, y: 120 }] }
            ]
        };
        expect(diagramBounds(graph)).toEqual({ x: 5, y: 20, width: 240, height: 230 });
    });

    test('traffic light: the transition routed around the states on the right lies beyond the nodes', async () => {
        const { graph } = await layoutStateMachine((await parse(example('traffic-light.devm'))).model, { direction: 'DOWN' });
        const bounds = diagramBounds(graph)!;
        const right = (nodes: DiagramNode[], ox = 0): number => Math.max(...nodes.map(n => Math.max(ox + n.x + n.width, right(n.children, ox + n.x))));
        const nodesRight = right(graph.children);
        expect(bounds.x + bounds.width).toBeGreaterThan(nodesRight);
        for (const edge of graph.edges) {
            if (edge.label) {
                expect(edge.label.x + edge.label.width).toBeLessThanOrEqual(bounds.x + bounds.width);
            }
        }
    });
});
