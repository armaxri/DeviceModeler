import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { DiagramGraph, DiagramNode } from '../src/diagram/diagram-model.js';
import { DEFINITION_ID, layoutStateMachine } from '../src/diagram/layout.js';
import {
    applyManualLayout, captureLayout, createManualLayout, edgeEndpoints, layoutStateMachineWithLayout, parseManualLayout, removeLayoutElements,
    renameLayoutElement, serializeManualLayout, type ManualLayout
} from '../src/diagram/manual-layout.js';
import { importSct } from '../src/importer/sct-importer.js';
import { example, parse } from './helpers.js';

interface AbsoluteNode extends DiagramNode {
    ax: number;
    ay: number;
}

function flatten(nodes: DiagramNode[], parentX = 0, parentY = 0): AbsoluteNode[] {
    return nodes.flatMap(n => [{ ...n, ax: parentX + n.x, ay: parentY + n.y }, ...flatten(n.children, parentX + n.x, parentY + n.y)]);
}

function byId(graph: DiagramGraph): Map<string, AbsoluteNode> {
    return new Map(flatten(graph.children).map(n => [n.id, n]));
}

function overlap(a: AbsoluteNode, b: AbsoluteNode): boolean {
    return a.ax < b.ax + b.width && b.ax < a.ax + a.width && a.ay < b.ay + b.height && b.ay < a.ay + a.height;
}

/** Children lie within their parents and siblings (except regions) do not overlap. */
function checkNesting(node: DiagramNode, path = node.id): void {
    for (const child of node.children) {
        expect(child.x, `${child.id} in ${path}`).toBeGreaterThanOrEqual(-0.01);
        expect(child.y, `${child.id} in ${path}`).toBeGreaterThanOrEqual(-0.01);
        expect(child.x + child.width, `${child.id} in ${path}`).toBeLessThanOrEqual(node.width + 0.01);
        expect(child.y + child.height, `${child.id} in ${path}`).toBeLessThanOrEqual(node.height + 0.01);
        checkNesting(child, `${path}/${child.id}`);
    }
}

const TEXT = `statemachine M {
    [*] -> A
    state A
    state B
    state C {
        [*] -> C1
        state C1
        state C2
        C1 -> C2 : go
    }
    A -> B : next
    B -> C : next
    C -> A : back
}
`;

describe('manual layout: persistence', () => {
    test('serialize and parse round trip', () => {
        const layout: ManualLayout = {
            version: 1, mode: 'manual', direction: 'RIGHT',
            nodes: { 'B': { x: 10.04, y: 20 }, 'A': { x: 1, y: 2, width: 100, height: 50, regions: 'horizontal' } },
            edges: { 'A->B': { bends: [{ x: 5, y: 6 }], label: { x: 1, y: -2 } }, 'B->A': {} }
        };
        const text = serializeManualLayout(layout);
        // sorted keys, rounded values, empty edge entries dropped
        expect(Object.keys(JSON.parse(text).nodes)).toEqual(['A', 'B']);
        expect(text).toContain('"x": 10');
        const parsed = parseManualLayout(text);
        expect(parsed.nodes['A']).toEqual({ x: 1, y: 2, width: 100, height: 50, regions: 'horizontal' });
        expect(parsed.edges['A->B']).toEqual({ bends: [{ x: 5, y: 6 }], label: { x: 1, y: -2 } });
        expect(parsed.edges['B->A']).toBeUndefined();
        expect(parsed.direction).toBe('RIGHT');
    });

    test('invalid files are rejected', () => {
        expect(() => parseManualLayout('{')).toThrow(/Invalid layout file/);
        expect(() => parseManualLayout('{"version": 2}')).toThrow(/version/);
        expect(() => parseManualLayout('{"version": 1, "nodes": {"A": {"x": "1"}}}')).toThrow(/node 'A'/);
    });

    test('edge ids', () => {
        expect(edgeEndpoints('A.B->C~2')).toEqual({ source: 'A.B', target: 'C', suffix: '~2' });
        expect(edgeEndpoints('#machine#initial->A')).toEqual({ source: '#machine#initial', target: 'A', suffix: '' });
        expect(edgeEndpoints('A#region1#initial->A.X')).toEqual({ source: 'A#region1#initial', target: 'A.X', suffix: '' });
    });

    test('rename updates nested keys and transitions', () => {
        const layout = createManualLayout();
        layout.nodes = { 'A': { x: 1, y: 1 }, 'A.X': { x: 2, y: 2 }, 'A#initial': { x: 3, y: 3 }, 'A#region1': { x: 0, y: 0, width: 50 }, 'AB': { x: 4, y: 4 } };
        layout.edges = { 'A.X->AB': { bends: [{ x: 0, y: 0 }] }, 'A#initial->A.X': { label: { x: 1, y: 1 } }, 'AB->AB~1': { label: { x: 0, y: 0 } } };
        const renamed = renameLayoutElement(layout, 'A', 'Z');
        expect(Object.keys(renamed.nodes).sort()).toEqual(['AB', 'Z', 'Z#initial', 'Z#region1', 'Z.X']);
        expect(Object.keys(renamed.edges).sort()).toEqual(['AB->AB~1', 'Z#initial->Z.X', 'Z.X->AB']);
        // the original is not modified
        expect(layout.nodes['A']).toBeDefined();
        // move into another state
        const moved = renameLayoutElement(layout, 'AB', 'A.AB');
        expect(moved.nodes['A.AB']).toEqual({ x: 4, y: 4 });
        expect(moved.edges['A.X->A.AB']).toBeDefined();
        expect(moved.edges['A.AB->A.AB~1']).toBeDefined();
    });

    test('remove deletes contained elements, transitions and renumbers regions', () => {
        const layout = createManualLayout();
        layout.nodes = { 'A': { x: 1, y: 1 }, 'A.X': { x: 2, y: 2 }, 'B': { x: 3, y: 3 }, 'S#region1': { x: 0, y: 0, width: 10 }, 'S#region2': { x: 0, y: 0, width: 20 },
            'S#region3': { x: 0, y: 0, width: 30 }, 'S#region3#initial': { x: 5, y: 5 } };
        layout.edges = { 'A.X->B': { label: { x: 0, y: 0 } }, 'B->B': { label: { x: 0, y: 0 } }, 'S#region3#initial->S.Q': { label: { x: 0, y: 0 } } };
        const removed = removeLayoutElements(layout, ['A', 'S#region2']);
        expect(Object.keys(removed.nodes).sort()).toEqual(['B', 'S#region1', 'S#region2', 'S#region2#initial']);
        expect(removed.nodes['S#region2'].width).toBe(30);
        expect(Object.keys(removed.edges).sort()).toEqual(['B->B', 'S#region2#initial->S.Q']);
    });
});

describe('manual layout: computation', () => {
    test('without manual layout the result is the automatic layout', async () => {
        const parsed = await parse(example('cd-player.hsm'));
        const auto = await layoutStateMachine(parsed.model);
        const none = await layoutStateMachineWithLayout(parsed.model, {});
        expect(none.graph).toEqual(auto.graph);
        const autoMode = await layoutStateMachineWithLayout(parsed.model, {}, { ...createManualLayout('auto'), nodes: { 'Closed': { x: 999, y: 999 } } });
        expect(autoMode.graph).toEqual(auto.graph);
    });

    for (const file of ['traffic-light.hsm', 'cd-player.hsm', 'keyboard.hsm', 'door.hsm']) {
        for (const direction of ['DOWN', 'RIGHT'] as const) {
            test(`captured automatic layout reproduces the diagram: ${file} (${direction})`, async () => {
                const parsed = await parse(example(file));
                const auto = await layoutStateMachine(parsed.model, { direction });
                const manual = applyManualLayout(auto, captureLayout(auto.graph), { direction });
                const autoNodes = byId(auto.graph);
                const manualNodes = byId(manual.graph);
                expect([...manualNodes.keys()].sort()).toEqual([...autoNodes.keys()].sort());
                for (const [id, node] of manualNodes) {
                    const before = autoNodes.get(id)!;
                    // positions of all vertices are kept exactly
                    expect(node.ax, id).toBeCloseTo(before.ax, 1);
                    expect(node.ay, id).toBeCloseTo(before.ay, 1);
                    if (!node.composite) {
                        expect(node.width, id).toBeCloseTo(before.width, 1);
                        expect(node.height, id).toBeCloseTo(before.height, 1);
                    }
                }
                manual.graph.children.forEach(n => checkNesting(n));
                // all transitions between vertices which were not moved keep the route of the automatic layout
                const kept = manual.graph.edges.filter(e => e.routing === auto.graph.edges.find(a => a.id === e.id)!.routing).length;
                expect(kept / manual.graph.edges.length).toBeGreaterThan(0.6);
                for (const edge of manual.graph.edges) {
                    expect(edge.points.length).toBeGreaterThanOrEqual(2);
                }
                // the effective layout contains all vertices
                expect(Object.keys(manual.effective!.nodes)).toEqual(expect.arrayContaining(['#machine#initial', ...[...autoNodes.values()].filter(n => n.kind === 'state').map(n => n.id)]));
            });
        }
    }

    test('pinned nodes keep their positions, new nodes are placed without overlap', async () => {
        const parsed = await parse(TEXT);
        const layout = createManualLayout();
        layout.nodes = {
            'A': { x: 300, y: 40 },
            'B': { x: 40, y: 200 }
        };
        const result = await layoutStateMachineWithLayout(parsed.model, {}, layout);
        const nodes = byId(result.graph);
        expect(nodes.get('A')).toMatchObject({ x: 300, y: 40 });
        expect(nodes.get('B')).toMatchObject({ x: 40, y: 200 });
        const topLevel = result.graph.children.map(n => nodes.get(n.id)!);
        for (const a of topLevel) {
            for (const b of topLevel) {
                if (a !== b) {
                    expect(overlap(a, b), `${a.id} / ${b.id}`).toBe(false);
                }
            }
        }
        result.graph.children.forEach(n => checkNesting(n));
        // moved vertices are connected by straight lines between their borders
        const ab = result.graph.edges.find(e => e.id === 'A->B')!;
        expect(ab.routing).toBe('polyline');
        expect(ab.points).toHaveLength(2);
        const a = nodes.get('A')!;
        const b = nodes.get('B')!;
        const onBorder = (p: { x: number, y: number }, n: AbsoluteNode) =>
            Math.abs(p.x - n.ax) < 0.5 || Math.abs(p.x - n.ax - n.width) < 0.5 || Math.abs(p.y - n.ay) < 0.5 || Math.abs(p.y - n.ay - n.height) < 0.5;
        expect(onBorder(ab.points[0], a)).toBe(true);
        expect(onBorder(ab.points[1], b)).toBe(true);
        expect(ab.label).toBeDefined();
    });

    test('composite states grow to fit their content and keep explicit sizes', async () => {
        const parsed = await parse(TEXT);
        const auto = await layoutStateMachine(parsed.model);
        const layout = captureLayout(auto.graph);
        layout.nodes['C.C2'] = { x: 400, y: 300 };
        layout.nodes['A'] = { ...layout.nodes['A'], width: 150, height: 90 };
        const result = applyManualLayout(auto, layout);
        const nodes = byId(result.graph);
        const c = nodes.get('C')!;
        expect(c.width).toBeGreaterThanOrEqual(400 + nodes.get('C.C2')!.width);
        expect(c.height).toBeGreaterThanOrEqual(300 + nodes.get('C.C2')!.height);
        expect(nodes.get('A')).toMatchObject({ width: 150, height: 90 });
        expect(result.graph.width).toBeGreaterThanOrEqual(c.ax + c.width);
        // explicit sizes are kept in the effective layout, positions are pinned
        expect(result.effective!.nodes['A']).toMatchObject({ width: 150, height: 90 });
        expect(result.effective!.nodes['C.C1']).toBeDefined();
    });

    test('content is kept below the header of its state', async () => {
        const parsed = await parse(TEXT);
        const auto = await layoutStateMachine(parsed.model);
        const layout = captureLayout(auto.graph);
        layout.nodes['C.C1'] = { x: 0, y: 0 };
        layout.nodes['C.C2'] = { x: 100, y: 5 };
        layout.edges['C.C1->C.C2'] = { bends: [{ x: 50, y: 60 }] };
        const result = applyManualLayout(auto, layout);
        const nodes = byId(result.graph);
        const c1 = nodes.get('C.C1')!;
        const c2 = nodes.get('C.C2')!;
        expect(c1.y).toBeGreaterThanOrEqual(26);
        expect(c1.x).toBeGreaterThan(0);
        // the content is shifted as a whole
        expect(c2.x - c1.x).toBeCloseTo(100);
        expect(c2.y - c1.y).toBeCloseTo(5);
        // bend points are shifted with the content
        const edge = result.graph.edges.find(e => e.id === 'C.C1->C.C2')!;
        const c = nodes.get('C')!;
        expect(edge.points[1].x - c.ax).toBeCloseTo(50 + c1.x);
        expect(edge.points).toHaveLength(3);
        expect(result.effective!.edges['C.C1->C.C2'].bends![0].x).toBeCloseTo(50 + c1.x);
    });

    test('stored label offsets and self transitions', async () => {
        const parsed = await parse(`statemachine M {
    [*] -> A
    state A
    state B
    A -> A : again
    A -> B : x
    B -> A : y
}
`);
        const auto = await layoutStateMachine(parsed.model);
        const layout = captureLayout(auto.graph);
        layout.nodes['A'] = { x: 40, y: 100 };
        layout.nodes['B'] = { x: 300, y: 100 };
        const plain = applyManualLayout(auto, layout);
        layout.edges['A->B'] = { label: { x: 10, y: 20 } };
        const moved = applyManualLayout(auto, layout);
        const before = plain.graph.edges.find(e => e.id === 'A->B')!.label!;
        const after = moved.graph.edges.find(e => e.id === 'A->B')!.label!;
        expect(after.x - before.x).toBeCloseTo(10);
        expect(after.y - before.y).toBeCloseTo(20);
        // parallel transitions in opposite directions do not coincide
        const ab = moved.graph.edges.find(e => e.id === 'A->B')!;
        const ba = moved.graph.edges.find(e => e.id === 'B->A')!;
        expect(ab.points).toHaveLength(3);
        expect(ba.points).toHaveLength(3);
        expect(Math.abs(ab.points[1].y - ba.points[1].y)).toBeGreaterThan(10);
        // self transition: a loop right of the state
        const loop = moved.graph.edges.find(e => e.id === 'A->A')!;
        const a = byId(moved.graph).get('A')!;
        expect(loop.points.length).toBeGreaterThanOrEqual(3);
        // (it keeps the route of the automatic layout, moved with the state)
        for (const p of loop.points) {
            expect(p.x).toBeGreaterThan(a.ax - 60);
            expect(p.x).toBeLessThan(a.ax + a.width + 60);
            expect(p.y).toBeGreaterThan(a.ay - 60);
            expect(p.y).toBeLessThan(a.ay + a.height + 60);
        }
    });

    test('the definition section does not cover states', async () => {
        const parsed = await parse(example('traffic-light.hsm'));
        const auto = await layoutStateMachine(parsed.model);
        const layout = captureLayout(auto.graph);
        // pretend the definition section was much narrower when the layout was stored
        const first = auto.graph.children.find(n => n.id !== DEFINITION_ID)!;
        layout.nodes[first.id] = { x: 30, y: layout.nodes[first.id].y };
        const result = applyManualLayout(auto, layout);
        const nodes = byId(result.graph);
        const definition = nodes.get(DEFINITION_ID)!;
        for (const node of result.graph.children) {
            if (node.id !== DEFINITION_ID) {
                expect(overlap(definition, nodes.get(node.id)!), node.id).toBe(false);
            }
        }
    });

    test('regions are stacked in the stored orientation', async () => {
        const parsed = await parse(example('keyboard.hsm'));
        const auto = await layoutStateMachine(parsed.model);
        const layout = captureLayout(auto.graph);
        layout.nodes['Active'] = { ...layout.nodes['Active'], regions: 'horizontal' };
        const result = applyManualLayout(auto, layout);
        const active = byId(result.graph).get('Active')!;
        const regions = active.children.filter(c => c.kind === 'region');
        expect(regions).toHaveLength(2);
        expect(regions[1].x).toBeCloseTo(regions[0].x + regions[0].width);
        expect(regions[0].y).toBe(regions[1].y);
        expect(regions[1].separator).toBe('left');
        expect(regions[1].x + regions[1].width).toBeCloseTo(active.width);
        checkNesting(active);
    });
});

describe('manual layout: import of the itemis CREATE notation model', () => {
    const fixture = (name: string) => fs.readFileSync(path.resolve(__dirname, 'importer/fixtures', name), 'utf-8');

    async function importAndLayout(name: string) {
        const result = importSct(fixture(name));
        expect(result.layout, name).toBeDefined();
        const parsed = await parse(result.text);
        const diagram = await layoutStateMachineWithLayout(parsed.model, {}, result.layout);
        return { ...result, layout: result.layout!, diagram, nodes: byId(diagram.graph) };
    }

    test('positions, sizes and region orientation (SyncJoin)', async () => {
        const { layout, nodes, diagram } = await importAndLayout('SyncJoin.sct');
        // itemis: region at (152, 10), state B at (4, 47) with size 279 x 321, A at (381, 195)
        expect(layout.nodes['B']).toEqual({ x: 156, y: 77, width: 279, height: 321, regions: 'vertical' });
        expect(layout.nodes['A']).toMatchObject({ x: 533, y: 225 });
        expect(layout.nodes['#definitions']).toEqual({ x: 10, y: 10 });
        expect(layout.nodes['B#region1#initial']).toBeDefined();
        expect(layout.edges['A->B'].bends).toHaveLength(1);
        const a = nodes.get('A')!;
        const b = nodes.get('B')!;
        expect(a.ax).toBeGreaterThan(b.ax + b.width);
        expect(b.width).toBeGreaterThanOrEqual(279);
        expect(b.height).toBeGreaterThanOrEqual(321);
        const [r1, r2] = b.children;
        expect(r2.y).toBeGreaterThanOrEqual(r1.y + r1.height - 0.01);
        expect(nodes.get('B.C1')!.ax).toBeLessThan(nodes.get('B.C2')!.ax);
        // the definition section (wider than in itemis) does not cover the states
        const definition = nodes.get(DEFINITION_ID)!;
        for (const node of diagram.graph.children.filter(n => n.id !== DEFINITION_ID)) {
            expect(overlap(definition, nodes.get(node.id)!), node.id).toBe(false);
        }
        // the transition with bend point is routed through it
        const edge = diagram.graph.edges.find(e => e.id === 'A->B')!;
        expect(edge.points).toHaveLength(3);
    });

    for (const name of ['TrafficLightWaiting.sct', 'state_multiple_entries.sct', 'SyncJoin.sct', 'DeepEntry.sct', 'ShallowHistory.sct', 'Choice.sct']) {
        test(`relative positions are preserved: ${name}`, async () => {
            const { layout, nodes, diagram } = await importAndLayout(name);
            const siblings = new Map<string, string[]>();
            const parentOf = new Map<string, string>();
            const visit = (children: DiagramNode[], parent: string) => children.forEach(child => {
                parentOf.set(child.id, parent);
                siblings.set(parent, [...(siblings.get(parent) ?? []), child.id]);
                visit(child.children, child.id);
            });
            visit(diagram.graph.children, '');
            let pairs = 0;
            let preserved = 0;
            for (const ids of siblings.values()) {
                const stored = ids.filter(id => layout.nodes[id] && !id.includes('#region') && id !== DEFINITION_ID);
                for (const a of stored) {
                    for (const b of stored) {
                        const dx = layout.nodes[b].x - layout.nodes[a].x;
                        if (dx > 40) {
                            pairs++;
                            preserved += nodes.get(b)!.ax > nodes.get(a)!.ax ? 1 : 0;
                        }
                    }
                }
            }
            expect(pairs).toBeGreaterThan(0);
            expect(preserved / pairs).toBeGreaterThan(0.9);
            // no overlapping siblings
            for (const ids of siblings.values()) {
                const list = ids.map(id => nodes.get(id)!).filter(n => n.kind !== 'region');
                for (const a of list) {
                    for (const b of list) {
                        if (a !== b) {
                            expect(overlap(a, b), `${a.id} / ${b.id}`).toBe(false);
                        }
                    }
                }
            }
            diagram.graph.children.forEach(n => checkNesting(n));
        });
    }

    test('several top-level regions: the generated state gets the bounds of the regions', async () => {
        const { layout, nodes } = await importAndLayout('DeepEntry.sct');
        expect(layout.nodes['Main']).toEqual({ x: 220, y: 10, regions: 'horizontal' });
        expect(layout.nodes['Main#region1']).toMatchObject({ width: 261, height: 400 });
        const regions = [1, 2, 3].map(i => nodes.get(`Main#region${i}`)!);
        expect(regions[0].width).toBeGreaterThanOrEqual(261);
        expect(regions[1].x).toBeCloseTo(regions[0].x + regions[0].width);
        expect(regions[2].x).toBeCloseTo(regions[1].x + regions[1].width);
    });

    test('the layout can be disabled; files without diagram have no layout', () => {
        expect(importSct(fixture('SyncJoin.sct'), { layout: false }).layout).toBeUndefined();
        const xml = fixture('SyncJoin.sct');
        const withoutDiagram = xml.substring(0, xml.indexOf('<notation:Diagram')) + xml.substring(xml.indexOf('</notation:Diagram>') + '</notation:Diagram>'.length);
        expect(importSct(withoutDiagram).layout).toBeUndefined();
    });
});
