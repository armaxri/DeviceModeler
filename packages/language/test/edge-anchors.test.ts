import { describe, expect, test } from 'vitest';
import type { DiagramEdge, DiagramGraph, DiagramNode, EdgeRouting, Point } from '../src/diagram/diagram-model.js';
import { anchorAt, anchorPoint, projectToBorder, STATE_CORNER_RADIUS, type EdgeAnchor } from '../src/diagram/edge-anchors.js';
import { displayRoute, arrowDirection } from '../src/diagram/edge-routes.js';
import { layoutFromModel, layoutTextEdits } from '../src/diagram/layout-annotations.js';
import { layoutStateMachine } from '../src/diagram/layout.js';
import {
    applyManualLayout, captureLayout, cloneManualLayout, layoutStateMachineWithLayout, parseManualLayout, selfLoopRoute, serializeManualLayout,
    type ManualLayout
} from '../src/diagram/manual-layout.js';
import { applyEdits } from '../src/edit/model-edits.js';
import { renderSvg } from '../src/render/svg.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { errors, loader, parse, warnings } from './helpers.js';

async function formatText(text: string): Promise<string> {
    const parsed = await parse(text);
    const edits = await loader.services.Hsm.lsp.Formatter!.formatDocument(parsed.document, {
        textDocument: { uri: parsed.document.uri.toString() },
        options: { tabSize: 4, insertSpaces: true }
    });
    return TextDocument.applyEdits(parsed.document.textDocument, edits);
}

const RECT = { x: 100, y: 50, width: 200, height: 80 };

describe('edge anchors: border projection', () => {
    test('points on the sides', () => {
        expect(anchorPoint(RECT, { side: 'top', position: 50 })).toEqual({ x: 200, y: 50 });
        expect(anchorPoint(RECT, { side: 'bottom', position: 25 })).toEqual({ x: 150, y: 130 });
        expect(anchorPoint(RECT, { side: 'left', position: 50 })).toEqual({ x: 100, y: 90 });
        expect(anchorPoint(RECT, { side: 'right', position: 75 })).toEqual({ x: 300, y: 110 });
    });

    test('positions in a rounded corner are moved to the end of the straight part', () => {
        const r = STATE_CORNER_RADIUS;
        expect(anchorPoint(RECT, { side: 'top', position: 0 })).toEqual({ x: 100 + r, y: 50 });
        expect(anchorPoint(RECT, { side: 'top', position: 100 })).toEqual({ x: 300 - r, y: 50 });
        expect(anchorPoint(RECT, { side: 'left', position: 2 })).toEqual({ x: 100, y: 50 + r });
        // a side shorter than two radii: its middle
        expect(anchorPoint({ x: 0, y: 0, width: 100, height: 20 }, { side: 'right', position: 10 })).toEqual({ x: 100, y: 10 });
    });

    test('projection onto the nearest side', () => {
        expect(projectToBorder(RECT, { x: 150, y: 20 })).toEqual({ side: 'top', position: 25 });
        expect(projectToBorder(RECT, { x: 350, y: 70 })).toEqual({ side: 'right', position: 25 });
        expect(projectToBorder(RECT, { x: 200, y: 200 })).toEqual({ side: 'bottom', position: 50 });
        expect(projectToBorder(RECT, { x: 0, y: 110 })).toEqual({ side: 'left', position: 75 });
        // inside the rectangle: the nearest side
        expect(projectToBorder(RECT, { x: 110, y: 90 })).toEqual({ side: 'left', position: 50 });
        expect(projectToBorder(RECT, { x: 200, y: 125 })).toEqual({ side: 'bottom', position: 50 });
    });

    test('projection near a corner: the end of the straight part of the nearer side', () => {
        const r = STATE_CORNER_RADIUS;
        // beyond the top right corner, more to the right than above
        const right = projectToBorder(RECT, { x: 330, y: 40 });
        expect(right.side).toBe('right');
        expect(anchorPoint(RECT, right).x).toBe(300);
        expect(anchorPoint(RECT, right).y).toBeCloseTo(50 + r, 0);
        // more above than to the right
        const top = projectToBorder(RECT, { x: 305, y: 10 });
        expect(top.side).toBe('top');
        expect(anchorPoint(RECT, top).x).toBeCloseTo(300 - r, 0);
        // precision
        expect(projectToBorder(RECT, { x: 133.3, y: 0 }, STATE_CORNER_RADIUS, 0.1).position).toBeCloseTo(16.7, 5);
    });

    test('anchor of a point on the border', () => {
        expect(anchorAt(RECT, { x: 300, y: 70 })).toEqual({ side: 'right', position: 25 });
        expect(anchorAt(RECT, { x: 150, y: 130.4 })).toEqual({ side: 'bottom', position: 25 });
        expect(anchorAt(RECT, { x: 150, y: 100 })).toBeUndefined();
    });
});

describe('edge anchors: annotations', () => {
    const TEXT = `statemachine M {
    interface:
        in event go
    [*] -> A
    state A
    state B
    A -> B : go
}
`;

    test('read, written and removed again (undo of the text edit restores the model)', async () => {
        const parsed = await parse(TEXT);
        const auto = await layoutStateMachine(parsed.model);
        const layout = captureLayout(auto.graph);
        layout.edges['A->B'] = { source: { side: 'bottom', position: 25.4 }, target: { side: 'top', position: 80 } };
        const text = applyEdits(TEXT, layoutTextEdits(parsed.model, TEXT, layout));
        expect(text).toContain('@from("bottom", 25) @to("top", 80)\n    A -> B : go');
        const reparsed = await parse(text);
        expect(errors(reparsed)).toEqual([]);
        expect(warnings(reparsed)).toEqual([]);
        const read = layoutFromModel(reparsed.model)!;
        expect(read.edges['A->B']).toEqual({ source: { side: 'bottom', position: 25 }, target: { side: 'top', position: 80 } });
        // writing the same layout again: no edits
        expect(layoutTextEdits(reparsed.model, text, read)).toEqual([]);
        // changing one anchor: replaced in place
        const changed = cloneManualLayout(read);
        changed.edges['A->B'].target = { side: 'left', position: 50 };
        const edits = layoutTextEdits(reparsed.model, text, changed);
        expect(edits).toHaveLength(1);
        expect(applyEdits(text, edits)).toContain('@from("bottom", 25) @to("left", 50)');
        // removing the anchors (reset): the annotation line disappears
        const reset = cloneManualLayout(read);
        delete reset.edges['A->B'];
        const restored = applyEdits(text, layoutTextEdits(reparsed.model, text, reset));
        expect(restored).not.toContain('@from');
        expect(restored).toContain('    A -> B : go');
        // a new @from is written before an existing @to
        const onlyTarget = cloneManualLayout(read);
        delete onlyTarget.edges['A->B'].source;
        const targetText = applyEdits(text, layoutTextEdits(reparsed.model, text, onlyTarget));
        expect(targetText).toContain('@to("top", 80)\n    A -> B : go');
        const targetParsed = await parse(targetText);
        expect(applyEdits(targetText, layoutTextEdits(targetParsed.model, targetText, read))).toBe(text);
        // clear positions removes everything
        expect(applyEdits(text, layoutTextEdits(reparsed.model, text, undefined))).toBe(TEXT);
    });

    test('validation', async () => {
        const model = (annotations: string, transition = 'A -> B') => `statemachine M {
    [*] -> A
    state A
    state B
    choice C
    C -> A
    ${annotations}
    ${transition}
}
`;
        expect(errors(await parse(model('@from("top", 10) @to("right", 100)')))).toEqual([]);
        expect(errors(await parse(model('@from("top", 12.5)')))).toEqual([]);
        expect(errors(await parse(model('@from("up", 10)')))[0]).toContain('@from takes a side');
        expect(errors(await parse(model('@to(10)')))[0]).toContain('@to takes a side');
        expect(errors(await parse(model('@to("left", 120)')))[0]).toContain('between 0 and 100');
        expect(errors(await parse(model('@to("left", -1)')))[0]).toContain('between 0 and 100');
        expect(errors(await parse(model('@to("left", "a")')))[0]).toContain('must be a number');
        expect(errors(await parse(model('@to("left", 1) @to("left", 2)')))[0]).toContain('Duplicate');
        expect(errors(await parse(`statemachine M {\n    @from("top", 10)\n    state A\n}\n`))[0]).toContain('layout annotation of transitions');
        expect(warnings(await parse(model('@to("left", 50)', 'A -> C'))).some(w => w.includes('@to is ignored'))).toBe(true);
        expect(warnings(await parse(model('@from("left", 50)', '[*] -> B'))).some(w => w.includes('@from is ignored'))).toBe(true);
        expect(warnings(await parse(model('@from("left", 50)', 'A -> B'))).some(w => w.includes('ignored'))).toBe(false);
        // invalid anchors are not read
        const parsed = await parse(model('@to("left", 120) @from("top", 10)'));
        expect(layoutFromModel(parsed.model)!.edges['A->B']).toEqual({ source: { side: 'top', position: 10 } });
    });

    test('formatter keeps the anchors', async () => {
        const text = 'statemachine M {\n    state A\n    state B\n    @from( "top" ,10 )   @to("left",50)\n    A -> B\n}\n';
        const formatted = await formatText(text);
        expect(formatted).toContain('@from("top", 10) @to("left", 50)');
    });

    test('layout files: anchors are serialized and parsed', () => {
        const layout: ManualLayout = { version: 1, mode: 'manual', nodes: {}, edges: { 'A->B': { source: { side: 'left', position: 33.33 } } } };
        expect(parseManualLayout(serializeManualLayout(layout)).edges['A->B']).toEqual({ source: { side: 'left', position: 33.3 } });
    });
});

// ---------------------------------------------------------------------------------------------
// Routing

function flatten(nodes: DiagramNode[], x = 0, y = 0): Array<DiagramNode & { ax: number, ay: number }> {
    return nodes.flatMap(n => [{ ...n, ax: x + n.x, ay: y + n.y }, ...flatten(n.children, x + n.x, y + n.y)]);
}

function absoluteRect(graph: DiagramGraph, id: string) {
    const node = flatten(graph.children).find(n => n.id === id)!;
    return { x: node.ax, y: node.ay, width: node.width, height: node.height };
}

function edge(graph: DiagramGraph, id: string): DiagramEdge {
    return graph.edges.find(e => e.id === id)!;
}

const near = (a: Point, b: Point, tolerance = 0.5) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;

/** The drawn route starts and ends at the given points and the arrow head points into the target. */
function expectEnds(e: DiagramEdge, start: Point | undefined, end: Point | undefined): void {
    const route = displayRoute(e);
    if (start) {
        expect(near(route.points[0], start), `start ${JSON.stringify(route.points[0])} != ${JSON.stringify(start)}`).toBe(true);
    }
    if (end) {
        expect(near(route.points[route.points.length - 1], end), `end ${JSON.stringify(route.points[route.points.length - 1])} != ${JSON.stringify(end)}`).toBe(true);
    }
}

const ROUTINGS: EdgeRouting[] = ['ORTHOGONAL', 'ROUNDED', 'POLYLINE', 'SMOOTH', 'SPLINES'];

const MODEL = `statemachine M {
    interface:
        in event go
        in event again
        in event enter
        in event reset
        in event up
        in event deep
        in event inner
    [*] -> A
    state A
    state B
    state X
    state C {
        [*] -> C1
        state C1
        state C2
        C1 -> C2 : inner
    }
    A -> B : go
    A -> A : again
    B -> C : enter
    C -> C1 : reset
    C2 -> C : up
    A -> C2 : deep
}
`;

async function setup(change: (layout: ManualLayout) => void) {
    const parsed = await parse(MODEL);
    expect(errors(parsed)).toEqual([]);
    const auto = await layoutStateMachine(parsed.model);
    const layout = captureLayout(auto.graph);
    layout.nodes['A'] = { x: 40, y: 60 };
    layout.nodes['B'] = { x: 320, y: 60 };
    layout.nodes['X'] = { x: 180, y: 200 };
    layout.nodes['C'] = { x: 40, y: 320 };
    layout.nodes['C#initial'] = { x: 20, y: 0 };
    layout.nodes['C.C1'] = { x: 60, y: 20 };
    layout.nodes['C.C2'] = { x: 260, y: 20 };
    change(layout);
    return { auto, layout };
}

describe('edge anchors: routes', () => {
    for (const routing of ROUTINGS) {
        test(`routes start and end at the anchors (${routing})`, async () => {
            const anchors: Record<string, { source?: EdgeAnchor, target?: EdgeAnchor }> = {
                'A->B': { source: { side: 'bottom', position: 70 }, target: { side: 'bottom', position: 30 } },
                'A->A': { source: { side: 'top', position: 30 }, target: { side: 'left', position: 50 } },
                'C->C.C1': { source: { side: 'left', position: 60 } },
                'C.C2->C': { target: { side: 'right', position: 30 }, source: { side: 'right', position: 50 } },
                'A->C.C2': { source: { side: 'right', position: 80 }, target: { side: 'top', position: 80 } }
            };
            const { auto, layout } = await setup(l => {
                for (const [id, a] of Object.entries(anchors)) {
                    l.edges[id] = a;
                }
            });
            const graph = applyManualLayout(auto, layout, { routing }).graph;
            for (const [id, a] of Object.entries(anchors)) {
                const e = edge(graph, id);
                expect(e, id).toBeDefined();
                const start = a.source ? anchorPoint(absoluteRect(graph, e.source), a.source) : undefined;
                const end = a.target ? anchorPoint(absoluteRect(graph, e.target), a.target) : undefined;
                expectEnds(e, start, end);
                if (routing === 'ORTHOGONAL' || routing === 'ROUNDED') {
                    // perpendicular to the side at the anchors
                    const p = e.points;
                    for (const [anchor, a0, a1] of [[a.source, p[0], p[1]], [a.target, p[p.length - 1], p[p.length - 2]]] as const) {
                        if (anchor) {
                            const vertical = anchor.side === 'top' || anchor.side === 'bottom';
                            expect(Math.abs(vertical ? a1.x - a0.x : a1.y - a0.y), `${id} ${JSON.stringify(p)}`).toBeLessThan(0.01);
                        }
                    }
                }
            }
            // the arrow head of A->B points up into the bottom side of B
            const ab = displayRoute(edge(graph, 'A->B'));
            const arrow = arrowDirection(ab.points);
            expect(arrow.from.y).toBeGreaterThan(arrow.to.y);
            if (routing === 'ORTHOGONAL' || routing === 'ROUNDED') {
                // perpendicular into the side
                expect(Math.abs(arrow.from.x - arrow.to.x)).toBeLessThan(0.01);
            } else {
                // at least 30 degrees away from the side
                expect(arrow.from.y - arrow.to.y).toBeGreaterThanOrEqual(0.5 * Math.hypot(arrow.from.x - arrow.to.x, arrow.from.y - arrow.to.y) - 0.01);
            }
            // the effective layout keeps the anchors
            const effective = applyManualLayout(auto, layout, { routing }).effective!;
            expect(effective.edges['A->B'].source).toEqual(anchors['A->B'].source);
            expect(effective.edges['A->A'].target).toEqual(anchors['A->A'].target);
        });
    }

    test('anchors and waypoints', async () => {
        const { auto, layout } = await setup(l => {
            l.edges['A->B'] = { source: { side: 'top', position: 50 }, target: { side: 'top', position: 50 }, bends: [{ x: 250, y: 20 }] };
            l.edges['C->C.C1'] = { source: { side: 'top', position: 10 }, bends: [{ x: 30, y: 70 }] };
        });
        for (const routing of ROUTINGS) {
            const graph = applyManualLayout(auto, layout, { routing }).graph;
            const e = edge(graph, 'A->B');
            expectEnds(e, anchorPoint(absoluteRect(graph, 'A'), { side: 'top', position: 50 }), anchorPoint(absoluteRect(graph, 'B'), { side: 'top', position: 50 }));
            expect(e.waypoints).toEqual([{ x: 250, y: 20 }]);
            const h = edge(graph, 'C->C.C1');
            expectEnds(h, anchorPoint(absoluteRect(graph, 'C'), { side: 'top', position: 10 }), undefined);
        }
    });

    test('the anchors follow a moved and resized state', async () => {
        const anchor: EdgeAnchor = { side: 'right', position: 25 };
        const { auto, layout } = await setup(l => {
            l.edges['A->B'] = { target: anchor };
        });
        const before = applyManualLayout(auto, layout, { routing: 'ORTHOGONAL' }).graph;
        layout.nodes['B'] = { x: 420, y: 120, width: 200, height: 100 };
        const after = applyManualLayout(auto, layout, { routing: 'ORTHOGONAL' }).graph;
        const b = absoluteRect(after, 'B');
        expect(b.width).toBe(200);
        expectEnds(edge(after, 'A->B'), undefined, { x: b.x + 200, y: b.y + 25 });
        expect(edge(before, 'A->B').points).not.toEqual(edge(after, 'A->B').points);
    });

    test('anchors at pseudo states are ignored', async () => {
        const { auto, layout } = await setup(l => {
            l.edges['#machine#initial->A'] = { source: { side: 'left', position: 0 } };
        });
        const plain = await setup(() => undefined);
        const anchored = applyManualLayout(auto, layout).graph;
        const unanchored = applyManualLayout(plain.auto, plain.layout).graph;
        const id = anchored.edges.find(e => e.target === 'A' && e.source.endsWith('#initial'))!.id;
        expect(edge(anchored, id).points).toEqual(edge(unanchored, id).points);
    });

    test('the SVG renderer draws the routes from / to the anchors (model with annotations)', async () => {
        const text = `statemachine M {
    interface:
        in event go
    @initial(80, 20)
    [*] -> A
    @at(40, 80)
    state A
    @at(300, 80)
    state B
    @from("bottom", 50) @to("bottom", 50)
    A -> B : go
}
`;
        const parsed = await parse(text);
        expect(errors(parsed)).toEqual([]);
        for (const routing of ['ORTHOGONAL', 'ROUNDED'] as const) {
            const { graph } = await layoutStateMachineWithLayout(parsed.model, { routing });
            const e = edge(graph, 'A->B');
            const start = anchorPoint(absoluteRect(graph, 'A'), { side: 'bottom', position: 50 });
            const end = anchorPoint(absoluteRect(graph, 'B'), { side: 'bottom', position: 50 });
            expectEnds(e, start, end);
            const svg = renderSvg(graph);
            const fmt = (v: number) => String(Math.round(v * 100) / 100);
            expect(svg).toContain(`d="M ${fmt(start.x)},${fmt(start.y)} `);
            // the route runs below the states
            expect(Math.max(...e.points.map(p => p.y))).toBeGreaterThan(start.y + 5);
        }
    });

    test('self transition loops', () => {
        const rect = { x: 0, y: 0, width: 100, height: 40 };
        // same side: a U in front of the side
        expect(selfLoopRoute(rect, { side: 'right', position: 25 }, { side: 'right', position: 75 }, 20))
            .toEqual([{ x: 100, y: 12.5 }, { x: 120, y: 12.5 }, { x: 120, y: 27.5 }, { x: 100, y: 27.5 }]);
        // adjacent sides: around the corner
        expect(selfLoopRoute(rect, { side: 'top', position: 80 }, { side: 'right', position: 50 }, 20))
            .toEqual([{ x: 80, y: 0 }, { x: 80, y: -20 }, { x: 120, y: -20 }, { x: 120, y: 20 }, { x: 100, y: 20 }]);
        // opposite sides: around the shorter way
        const loop = selfLoopRoute(rect, { side: 'top', position: 80 }, { side: 'bottom', position: 80 }, 20);
        expect(loop[0]).toEqual({ x: 80, y: 0 });
        expect(loop[loop.length - 1]).toEqual({ x: 80, y: 40 });
        expect(Math.max(...loop.map(p => p.x))).toBe(120);
    });
});
