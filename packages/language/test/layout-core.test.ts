import { describe, expect, test } from 'vitest';
import {
    LayoutTree, annotationSlotEdits, borderPlacement, edgeFrameOrigin, insertAnnotations, placeChildren, routeThroughWaypoints, separate,
    type AnnotationSlot, type WrittenAnnotation
} from '../src/diagram/layout-core/index.js';
import { applyEdits } from '../src/edit/model-edits.js';

/** A slot for the annotations of `text` found by a regular expression (name and numbers), the element at `elementOffset`. */
function slot(text: string, element: string, wanted: AnnotationSlot['wanted'], layoutNames = ['at', 'size', 'port'], ownLine = true): AnnotationSlot {
    const elementOffset = text.indexOf(element);
    const written: WrittenAnnotation[] = [];
    const lineStart = text.lastIndexOf('\n', elementOffset - 1) + 1;
    const previousLine = text.lastIndexOf('\n', lineStart - 2) + 1;
    const region = text.substring(previousLine, elementOffset);
    for (const match of region.matchAll(/@(\w+)\(([^)]*)\)/g)) {
        const name = match[1];
        const args = match[2].split(',').map(a => a.trim()).filter(a => a).map(a => /^-?\d+(\.\d+)?$/.test(a) ? Number(a) : a.startsWith('"') ? a.slice(1, -1) : { name: a });
        const offset = previousLine + match.index!;
        written.push({ name, key: name === 'port' ? `port:${(args[0] as { name: string }).name}` : name, layout: layoutNames.includes(name), args, offset, end: offset + match[0].length });
    }
    return { written, wanted, insert: added => insertAnnotations(elementOffset, text, added, ownLine) };
}

describe('layout core: annotation edits', () => {
    test('new annotations on a line of their own, with the indentation of the element', () => {
        const text = 'a {\n    thread T {\n    }\n}\n';
        const edits = annotationSlotEdits(text, [slot(text, 'thread T', [{ name: 'at', args: [10.4, -20.6] }, { name: 'size', args: [100, 50] }])]);
        expect(applyEdits(text, edits)).toBe('a {\n    @at(10, -21) @size(100, 50)\n    thread T {\n    }\n}\n');
    });

    test('new annotations in front of the element on the same line', () => {
        const text = 'thread T {\n    door : D\n}\n';
        const edits = annotationSlotEdits(text, [slot(text, 'door', [{ name: 'at', args: [1, 2] }], undefined, false)]);
        expect(applyEdits(text, edits)).toBe('thread T {\n    @at(1, 2) door : D\n}\n');
    });

    test('values are replaced in place, new ones appended to the existing annotations, other annotations kept', () => {
        const text = '@priority(5) @at(1, 2)\nthread T {}\n';
        const edits = annotationSlotEdits(text, [slot(text, 'thread T', [{ name: 'at', args: [3, 4] }, { name: 'size', args: [10, 20] }])]);
        expect(applyEdits(text, edits)).toBe('@priority(5) @at(3, 4) @size(10, 20)\nthread T {}\n');
    });

    test('unchanged values give no edits; a removed annotation takes its line with it if it becomes empty', () => {
        const text = '@at(1, 2)\nthread T {}\n';
        expect(annotationSlotEdits(text, [slot(text, 'thread T', [{ name: 'at', args: [1.2, 2] }])])).toEqual([]);
        expect(applyEdits(text, annotationSlotEdits(text, [slot(text, 'thread T', [])]))).toBe('thread T {}\n');
        const inline = '@priority(5) @at(1, 2) @size(3, 4)\nthread T {}\n';
        expect(applyEdits(inline, annotationSlotEdits(inline, [slot(inline, 'thread T', [])]))).toBe('@priority(5)\nthread T {}\n');
    });

    test('annotations with a key: one per port, names and strings as arguments', () => {
        const text = '@port(a, left, 10) @port(b, right) d : D\n';
        const edits = annotationSlotEdits(text, [slot(text, 'd : D', [
            { name: 'port', key: 'port:a', args: [{ name: 'a' }, { name: 'top' }, 30] },
            { name: 'port', key: 'port:c', args: [{ name: 'c' }, 'bottom'] }
        ], undefined, false)]);
        expect(applyEdits(text, edits)).toBe('@port(a, top, 30) @port(c, "bottom") d : D\n');
    });
});

describe('layout core: placement, hierarchy, routing', () => {
    test('pinned nodes stay, overlapping ones are pushed apart, new nodes are placed near their automatic position', () => {
        const nodes = [
            { id: 'a', x: 0, y: 0, width: 100, height: 50 },
            { id: 'b', x: 0, y: 0, width: 100, height: 50 },
            { id: 'c', x: 0, y: 0, width: 100, height: 50 }
        ];
        const auto: Record<string, { x: number, y: number }> = { a: { x: 10, y: 10 }, b: { x: 200, y: 10 }, c: { x: 10, y: 10 } };
        const stored: Record<string, { x: number, y: number }> = { a: { x: 40, y: 50 }, b: { x: 60, y: 60 } };
        const shift = placeChildren({ children: nodes, stored: n => stored[n.id], auto: n => auto[n.id], left: 20, top: 30 });
        expect(shift).toBeUndefined();
        expect(nodes[0]).toMatchObject({ x: 40, y: 50 });
        // b overlapped a: pushed away (down: the shorter way); c (where a is in the automatic layout,
        // translated like a) moved to a free place
        const [a, b, c] = nodes;
        expect(b).toMatchObject({ x: 60, y: 120 });
        const apart = (p: typeof a, q: typeof a) => p.x >= q.x + q.width || p.x + p.width <= q.x || p.y >= q.y + q.height || p.y + p.height <= q.y;
        expect(apart(a, b) && apart(c, a) && apart(c, b)).toBe(true);
        // pinned nodes above the content area are shifted down as a whole
        const header = [{ id: 'a', x: 0, y: 0, width: 10, height: 10 }];
        expect(placeChildren({ children: header, stored: () => ({ x: 5, y: 0 }), auto: () => ({ x: 0, y: 0 }), left: 0, top: 20 })).toEqual({ x: 0, y: 20 });
        expect(header[0]).toMatchObject({ x: 5, y: 20 });
        const overlapping = [{ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 }];
        separate(overlapping);
        expect(overlapping[1].x).toBe(30);
    });

    test('frames of edges, absolute positions', () => {
        interface N { id: string, x: number, y: number, width: number, height: number, children: N[] }
        const leaf = (id: string, x: number, y: number): N => ({ id, x, y, width: 10, height: 10, children: [] });
        const inner = { id: 'T', x: 50, y: 60, width: 100, height: 100, children: [leaf('a', 5, 5), leaf('b', 30, 5)] };
        const frame = { id: 'F', x: 10, y: 10, width: 300, height: 300, children: [inner, leaf('c', 200, 20)] };
        const root: N = { id: '#root', x: 0, y: 0, width: 0, height: 0, children: [frame] };
        const tree = new LayoutTree<N>(root, n => n.children);
        expect(tree.frameOf('a', 'b')).toBe('T');
        expect(tree.frameOf('a', 'c')).toBe('F');
        expect(tree.frameOf('a', 'a')).toBe('T');
        expect(tree.frameOf('F', 'a')).toBe('F');
        expect(tree.absolutePosition('b')).toEqual({ x: 90, y: 75 });
        expect(tree.boundsIn('b', 'F')).toEqual({ x: 80, y: 65, width: 10, height: 10 });
        expect(edgeFrameOrigin([frame], n => n.children, 'a', 'b')).toEqual({ x: 60, y: 70 });
        expect(edgeFrameOrigin([frame], n => n.children, 'a', 'unknown')).toEqual({ x: 0, y: 0 });
    });

    test('the nearest side of a node and the offset along it', () => {
        const rect = { x: 100, y: 100, width: 200, height: 100 };
        expect(borderPlacement(rect, { x: 95, y: 150 })).toEqual({ side: 'WEST', offset: 50 });
        expect(borderPlacement(rect, { x: 180, y: 205 })).toEqual({ side: 'SOUTH', offset: 80 });
        expect(borderPlacement(rect, { x: 299, y: 101 }, 12)).toEqual({ side: 'EAST', offset: 12 });
        expect(borderPlacement(rect, { x: 120, y: 90 }, 12)).toEqual({ side: 'NORTH', offset: 20 });
    });

    test('routes through waypoints around obstacles', () => {
        const route = routeThroughWaypoints({
            source: { x: 0, y: 50, width: 0, height: 0 }, target: { x: 300, y: 50, width: 0, height: 0 },
            waypoints: [{ x: 150, y: 200 }],
            obstacles: [{ x: 100, y: 0, width: 100, height: 120 }],
            sourceFixed: true, targetFixed: true,
            bounds: { minX: -50, minY: -50, maxX: 400, maxY: 300 }
        })!;
        expect(route).toBeDefined();
        expect(route.points[0]).toEqual({ x: 0, y: 50 });
        expect(route.points[route.points.length - 1]).toEqual({ x: 300, y: 50 });
        expect(route.points).toContainEqual({ x: 150, y: 200 });
        // orthogonal
        for (let i = 0; i + 1 < route.points.length; i++) {
            const [p, q] = [route.points[i], route.points[i + 1]];
            expect(Math.abs(p.x - q.x) < 0.01 || Math.abs(p.y - q.y) < 0.01).toBe(true);
        }
    });
});
