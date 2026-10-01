import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { diagramElementIds } from '../src/diagram/diagram-ids.js';
import { layoutStateMachine } from '../src/diagram/layout.js';
import { hasLayoutAnnotations, layoutFromModel, layoutTextEdits } from '../src/diagram/layout-annotations.js';
import { applyManualLayout, captureLayout, layoutStateMachineWithLayout, type ManualLayout } from '../src/diagram/manual-layout.js';
import { ModelEditor, applyEdits } from '../src/edit/model-edits.js';
import { containerAnnotations, elementAnnotations, semanticAnnotations } from '../src/model-annotations.js';
import { definitionLines, hasDefinitionSection } from '../src/model-utils.js';
import * as ast from '../src/generated/ast.js';
import { errors, parse, warnings } from './helpers.js';
import { importSctFiles } from '../src/importer/sct-importer.js';

const EXAMPLES = path.resolve(__dirname, '../../../examples');

/** The example models with the files they import. */
function examples(): Array<{ name: string, text: string, files: Record<string, string> }> {
    const result: Array<{ name: string, text: string, files: Record<string, string> }> = [];
    const visit = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory() && entry.name !== 'cmake' && entry.name !== 'tests') {
                visit(file);
            } else if (entry.name.endsWith('.hsm')) {
                const files: Record<string, string> = {};
                for (const other of fs.readdirSync(dir)) {
                    if (other !== entry.name && (other.endsWith('.hsm') || other.endsWith('.h'))) {
                        files[other] = fs.readFileSync(path.join(dir, other), 'utf-8');
                    }
                }
                result.push({ name: path.relative(EXAMPLES, file), text: fs.readFileSync(file, 'utf-8'), files });
            }
        }
    };
    visit(EXAMPLES);
    return result;
}

/** The layout with all numbers rounded (as written into the text). */
function rounded(layout: ManualLayout): { nodes: ManualLayout['nodes'], edges: ManualLayout['edges'] } {
    const r = (v: number) => Math.round(v) || 0;
    const nodes: ManualLayout['nodes'] = {};
    for (const [id, n] of Object.entries(layout.nodes)) {
        nodes[id] = {
            x: r(n.x), y: r(n.y),
            ...(n.width !== undefined && r(n.width) > 0 ? { width: r(n.width) } : {}),
            ...(n.height !== undefined && r(n.height) > 0 ? { height: r(n.height) } : {}),
            ...(n.regions ? { regions: n.regions } : {})
        };
    }
    const edges: ManualLayout['edges'] = {};
    for (const [id, e] of Object.entries(layout.edges)) {
        edges[id] = {
            ...(e.bends?.length ? { bends: e.bends.map(p => ({ x: r(p.x), y: r(p.y) })) } : {}),
            ...(e.label ? { label: { x: r(e.label.x), y: r(e.label.y) } } : {})
        };
    }
    return { nodes, edges };
}

async function write(text: string, layout: ManualLayout | undefined, files: Record<string, string> = {}) {
    const parsed = await parse(text, files);
    const edits = layoutTextEdits(parsed.model, text, layout);
    const result = applyEdits(text, edits);
    const reparsed = await parse(result, files);
    expect(reparsed.hasSyntaxErrors, result).toBe(false);
    return { text: result, parsed: reparsed, edits };
}

describe('layout annotations: diagram ids', () => {
    for (const example of examples()) {
        test(`the ids are the ids of the diagram: ${example.name}`, async () => {
            const parsed = await parse(example.text, example.files);
            const { graph, ids: builderIds } = await layoutStateMachine(parsed.model);
            const ids = diagramElementIds(parsed.model);
            for (const [node, id] of builderIds) {
                if (ast.isVertex(node) || ast.isRegion(node) || ast.isTransition(node)) {
                    expect(ids.ids.get(node), id).toBe(id);
                }
            }
            const nodeIds = new Set<string>();
            const visit = (nodes: typeof graph.children) => nodes.forEach(n => { nodeIds.add(n.id); visit(n.children); });
            visit(graph.children);
            for (const id of [...ids.initial.values(), ...ids.final.values()]) {
                expect(nodeIds.has(id), id).toBe(true);
            }
            expect([...nodeIds].filter(id => id.endsWith('#initial') || id.includes('#initial~')).length).toBe(ids.initial.size);
        });
    }
});

describe('layout annotations: writing and reading', () => {
    for (const example of examples()) {
        for (const direction of ['DOWN', 'RIGHT'] as const) {
            test(`round trip of the captured automatic layout: ${example.name} (${direction})`, async () => {
                const parsed = await parse(example.text, example.files);
                expect(layoutFromModel(parsed.model)).toBeUndefined();
                const auto = await layoutStateMachine(parsed.model, { direction });
                const layout = captureLayout(auto.graph, direction);
                // waypoints, label offsets and sizes as well
                auto.graph.edges.slice(0, 3).forEach((e, i) => {
                    layout.edges[e.id] = { bends: [{ x: 10 + i, y: -20.4 }, { x: 30.6, y: 40 }], label: { x: -3, y: 4 } };
                });
                const states: string[] = [];
                const visit = (nodes: typeof auto.graph.children) => nodes.forEach(n => { if (n.kind === 'state') states.push(n.id); visit(n.children); });
                visit(auto.graph.children);
                const state = states[0];
                if (state) {
                    layout.nodes[state] = { ...layout.nodes[state], width: 222, height: 111 };
                }
                const { text, parsed: reparsed } = await write(example.text, layout, example.files);
                expect(errors(reparsed), text).toEqual(errors(parsed));
                expect(warnings(reparsed).length, text).toBe(warnings(parsed).length);
                const read = layoutFromModel(reparsed.model);
                expect(read).toBeDefined();
                expect(rounded(read!)).toEqual(rounded(layout));
                // idempotent
                expect(layoutTextEdits(reparsed.model, text, read)).toEqual([]);
                expect(layoutTextEdits(reparsed.model, text, layout)).toEqual([]);
                // the definition section does not show layout annotations
                expect(definitionLines(reparsed.model)).toEqual(definitionLines(parsed.model));
                expect(hasDefinitionSection(reparsed.model)).toBe(hasDefinitionSection(parsed.model));
                // the same diagram as with the layout itself
                const fromAnnotations = await layoutStateMachineWithLayout(reparsed.model, { direction });
                const direct = applyManualLayout(await layoutStateMachine(reparsed.model, { direction }), read!, { direction });
                expect(fromAnnotations.graph.children).toEqual(direct.graph.children);
                // removing the layout restores the original text
                const removed = await write(text, undefined, example.files);
                expect(removed.text).toBe(example.text);
                expect(hasLayoutAnnotations(removed.parsed.model)).toBe(false);
            });
        }
    }

    test('a state machine without interfaces: own annotations and those of the first element', async () => {
        const text = `statemachine M {
    [*] -> A
    state A
    state B
    A -> B : go
    B -> A : back
    A -> B : again
}
`;
        const parsed = await parse(text);
        const auto = await layoutStateMachine(parsed.model);
        const layout = captureLayout(auto.graph);
        layout.edges['A->B~1'] = { bends: [{ x: 1, y: 2 }] };
        layout.edges['#machine#initial->A'] = { label: { x: 5, y: 5 } };
        const { text: written, parsed: reparsed } = await write(text, layout);
        expect(errors(reparsed), written).toEqual(errors(parsed));
        expect(warnings(reparsed), written).toEqual(warnings(parsed));
        // all annotations are members of the state machine: its own and those of the following elements
        expect(reparsed.model.annotations.map(a => a.name)).toEqual(expect.arrayContaining(['initial', 'label']));
        expect(containerAnnotations(reparsed.model).map(a => a.name)).toEqual(['initial']);
        expect(elementAnnotations(reparsed.model.transitions[0]).map(a => a.name)).toEqual(['label']);
        expect(semanticAnnotations(reparsed.model)).toEqual([]);
        expect(hasDefinitionSection(reparsed.model)).toBe(false);
        expect(rounded(layoutFromModel(reparsed.model)!)).toEqual(rounded(layout));
        expect(layoutTextEdits(reparsed.model, written, layout)).toEqual([]);
        // moving a node changes only its annotation
        const moved = { ...layout, nodes: { ...layout.nodes, A: { x: 500, y: 600 } } };
        const edits = layoutTextEdits(reparsed.model, written, moved);
        expect(edits).toHaveLength(1);
        expect(edits[0].text).toBe('@at(500, 600)');
        expect((await write(written, undefined)).text).toBe(text);
    });

    test('changes: values in place, new annotations appended, removed annotations with their line', async () => {
        const text = `statemachine M {
    @CycleBased(100)
    interface:
        in event go
    [*] -> A
    // the first state
    @at(10, 20) @size(100, 60)
    state A
    @at(300, 20)
    state B {
        [*] -> C
        state C
    }
    @via(1, 2) @label(3, 4)
    A -> B : go
}
`;
        const parsed = await parse(text);
        expect(errors(parsed)).toEqual([]);
        const layout = layoutFromModel(parsed.model)!;
        expect(layout.nodes['A']).toEqual({ x: 10, y: 20, width: 100, height: 60 });
        expect(layout.nodes['B']).toEqual({ x: 300, y: 20 });
        expect(layout.edges['A->B']).toEqual({ bends: [{ x: 1, y: 2 }], label: { x: 3, y: 4 } });
        const changed: ManualLayout = {
            ...layout,
            nodes: { A: { x: 11, y: 20 }, B: { x: 300, y: 20, width: 400, height: 200 }, 'B.C': { x: 5, y: 6 } },
            edges: { 'A->B': { label: { x: 3, y: 4 } } }
        };
        const { text: written } = await write(text, changed);
        expect(written).toBe(`statemachine M {
    @CycleBased(100)
    interface:
        in event go
    [*] -> A
    // the first state
    @at(11, 20)
    state A
    @at(300, 20) @size(400, 200)
    state B {
        [*] -> C
        @at(5, 6)
        state C
    }
    @label(3, 4)
    A -> B : go
}
`);
        const auto = await write(written, undefined);
        expect(auto.text).toBe(`statemachine M {
    @CycleBased(100)
    interface:
        in event go
    [*] -> A
    // the first state
    state A
    state B {
        [*] -> C
        state C
    }
    A -> B : go
}
`);
    });
});

describe('layout annotations: validation', () => {
    const model = (body: string) => `statemachine M {
    interface:
        in event e
    [*] -> A
${body}
    state B
    A -> B : e
}
`;

    test('valid annotations', async () => {
        const parsed = await parse(model(`    @definitions(10, 10, 300, 200) @initial(-5, +5)
    @at(10, 20) @size(100.5, 60) @regions("horizontal")
    state A {
        @initial(1, 1) @final(2, 2)
        [*] -> A1
        @at(1, 2)
        state A1
        @at(3, 4)
        choice c
        @via(1, 2, 3, 4) @label(-1, 2)
        A1 -> [*] : e
        A1 -> c : e [true]
        c -> A1
    }`));
        expect(errors(parsed)).toEqual([]);
        expect(warnings(parsed)).toEqual([]);
        const layout = layoutFromModel(parsed.model)!;
        expect(layout.nodes['A']).toEqual({ x: 10, y: 20, width: 100.5, height: 60, regions: 'horizontal' });
        expect(layout.nodes['#definitions']).toEqual({ x: 10, y: 10, width: 300, height: 200 });
        expect(layout.nodes['#machine#initial']).toEqual({ x: -5, y: 5 });
        expect(layout.nodes['A#initial']).toEqual({ x: 1, y: 1 });
        expect(layout.nodes['A#final']).toEqual({ x: 2, y: 2 });
        expect(layout.edges['A.A1->A#final']).toEqual({ bends: [{ x: 1, y: 2 }, { x: 3, y: 4 }], label: { x: -1, y: 2 } });
        // written back unchanged, except the numbers are written as integers
        expect(layoutTextEdits(parsed.model, parsed.document.textDocument.getText(), layout).map(e => e.text)).toEqual(['@size(101, 60)']);
    });

    test('invalid annotations', async () => {
        const parsed = await parse(model(`    @at(1) @size(1, 2, 3) @via(1, 2) @label(1, 2) @regions("diagonal") @at(4, 5)
    state A {
        @CycleBased(10)
        @definitions(1, 2)
        @via(1, 2, 3)
        A -> A : e
        @at(x, 2)
        choice c
        @size(1, 2)
        choice d
        @at(1, 2)
    }`));
        expect(errors(parsed)).toEqual(expect.arrayContaining([
            '@at takes x and y.',
            '@size takes width and height.',
            '@via is a layout annotation of transitions.',
            '@label is a layout annotation of transitions.',
            '@regions takes one argument: "vertical" or "horizontal".',
            "Duplicate annotation '@at'.",
            '@CycleBased is an annotation of the state machine.',
            '@definitions is a layout annotation of the state machine.',
            '@via takes the coordinates of one or more waypoints (x1, y1, x2, y2, ...).',
            'The arguments of @at must be numbers.',
            '@size is a layout annotation of states and regions.',
            '@at must be written directly before the element it belongs to.'
        ]));
    });

    test('the definition section comes first', async () => {
        const parsed = await parse(`statemachine M {
    [*] -> A
    state A
    @CycleBased(100)
    interface:
        in event e
}
`);
        expect(errors(parsed)).toEqual(expect.arrayContaining([
            'Interfaces and the internal scope must come before the states and transitions.',
            '@CycleBased must come before the interfaces, states and transitions.'
        ]));
    });
});

describe('layout annotations: diagram edits', () => {
    const text = `statemachine M {
    @initial(5, 5)
    [*] -> A
    @at(10, 20) @size(100, 60)
    state A
    @at(300, 20)
    state B {
        [*] -> C
        state C
    }
    @via(1, 2)
    A -> B
}
`;

    test('deleting an element deletes its annotations', async () => {
        const parsed = await parse(text);
        const a = parsed.model.vertices.find(v => v.name === 'A')!;
        const result = applyEdits(text, new ModelEditor(text, parsed.model).deleteElements([a]).edits);
        expect(result).toBe(`statemachine M {
    @initial(5, 5)
    @at(300, 20)
    state B {
        [*] -> C
        state C
    }
}
`);
    });

    test('moving a vertex moves its annotations', async () => {
        const parsed = await parse(text);
        const a = parsed.model.vertices.find(v => v.name === 'A')!;
        const b = parsed.model.vertices.find(v => v.name === 'B') as ast.State;
        const result = applyEdits(text, new ModelEditor(text, parsed.model).moveVertex(a, b).edits);
        const reparsed = await parse(result);
        expect(reparsed.hasSyntaxErrors).toBe(false);
        const moved = (reparsed.model.vertices.find(v => v.name === 'B') as ast.State).vertices.find(v => v.name === 'A')!;
        expect(elementAnnotations(moved).map(a => a.name)).toEqual(['at', 'size']);
        expect(result).not.toContain('@at(10, 20) @size(100, 60)\n    @at(300, 20)');
    });
});

describe('layout annotations: command line', () => {
    /** Runs the command line tool (the build in `out/`, see `npm run build`). */
    async function run(...args: string[]): Promise<string> {
        const { execFileSync } = await import('node:child_process');
        return execFileSync(process.execPath, [path.resolve(__dirname, '../bin/cli.js'), ...args], { encoding: 'utf-8' });
    }

    test('migrate-layout writes the layout file into the model; import writes annotations', async () => {
        const os = await import('node:os');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-layout-'));
        try {
            const model = path.join(dir, 'm.hsm');
            const text = `statemachine M {
    interface:
        in event go
    [*] -> A
    state A
    state B
    A -> B : go
}
`;
            fs.writeFileSync(model, text);
            fs.writeFileSync(model + '.layout', JSON.stringify({
                version: 1, mode: 'manual',
                nodes: { A: { x: 10, y: 20 }, B: { x: 200, y: 20, width: 120, height: 50 }, '#machine#initial': { x: 30, y: 0 } },
                edges: { 'A->B': { bends: [{ x: 100, y: 80 }] } }
            }));
            const output = await run('migrate-layout', model);
            expect(output).toContain('can be deleted');
            expect(fs.existsSync(model + '.layout')).toBe(true);
            const migrated = fs.readFileSync(model, 'utf-8');
            expect(migrated).toBe(`statemachine M {
    interface:
        in event go
    @initial(30, 0)
    [*] -> A
    @at(10, 20)
    state A
    @at(200, 20) @size(120, 50)
    state B
    @via(100, 80)
    A -> B : go
}
`);
            const json = await run('layout', model);
            const graph = JSON.parse(json.substring(json.indexOf('{')));
            expect(graph.children.find((n: { id: string }) => n.id === 'B')).toMatchObject({ x: 200, y: 20, width: 120, height: 50 });

            const sct = path.join(dir, 'Choice.sct');
            fs.copyFileSync(path.resolve(__dirname, 'importer/fixtures/Choice.sct'), sct);
            await run('import', sct);
            expect(fs.readFileSync(path.join(dir, 'Choice.hsm'), 'utf-8')).toContain('@at(');
            expect(fs.existsSync(path.join(dir, 'Choice.hsm.layout'))).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('layout annotations: itemis import', () => {
    test('several statecharts imported together get their layout annotations', async () => {
        const fixture = (name: string) => fs.readFileSync(path.resolve(__dirname, 'importer/fixtures', name), 'utf-8');
        const results = importSctFiles(['SyncJoin.sct', 'Choice.sct'].map(fileName => ({ fileName, xml: fixture(fileName) })));
        for (const result of results) {
            expect(result.text, result.fileName).toContain('@at(');
            const parsed = await parse(result.text);
            expect(parsed.hasSyntaxErrors, result.fileName).toBe(false);
            expect(errors(parsed).filter(e => e.includes('@')), result.fileName).toEqual([]);
            expect(layoutFromModel(parsed.model), result.fileName).toBeDefined();
        }
    });
});
