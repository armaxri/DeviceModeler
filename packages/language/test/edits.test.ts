import { describe, expect, test } from 'vitest';
import * as ast from '../src/generated/ast.js';
import { applyEdits, ModelEditor, type EditResult } from '../src/edit/model-edits.js';
import { allVertices } from '../src/model-utils.js';
import { parse } from './helpers.js';

const base = `statemachine M {
    interface:
        in event go
        in event next
        in event reset
        in event start
        var x : integer
        operation a() : void
        operation b() : void
        operation init() : void
        operation log(msg : string) : void

    [*] -> A

    state A {
        entry / a()
    }
    state B {
        [*] -> B1
        state B1
        state B2 // comment
        B1 -> B2 : next
    }

    A -> B : go
}
`;

async function edit(text: string, op: (editor: ModelEditor, find: (name: string) => ast.Vertex, model: ast.StateMachine) => EditResult) {
    const parsed = await parse(text);
    const editor = new ModelEditor(text, parsed.model);
    const find = (name: string) => allVertices(parsed.model).find(v => v.name === name)!;
    const result = op(editor, find, parsed.model);
    const newText = applyEdits(text, result.edits);
    const reparsed = await parse(newText);
    expect(reparsed.hasSyntaxErrors, newText).toBe(false);
    return { text: newText, result, parsed: reparsed };
}

describe('ModelEditor', () => {
    test('add state to the state machine', async () => {
        const { text, result } = await edit(base, (e, _f, m) => e.addVertex(m, 'state'));
        expect(result.createdName).toBe('State1');
        expect(text).toContain(`    state B {
        [*] -> B1
        state B1
        state B2 // comment
        B1 -> B2 : next
    }
    state State1
`);
        expect(text.substring(result.selectOffset!)).toMatch(/^state State1/);
    });

    test('add state to a simple state creates a body', async () => {
        const { text } = await edit(base, (e, f) => e.addVertex(f('B1') as ast.State, 'state', 'Inner'));
        expect(text).toContain(`        state B1 {
            state Inner
        }
`);
    });

    test('add choice to a composite state', async () => {
        const { text } = await edit(base, (e, f) => e.addVertex(f('B') as ast.State, 'choice'));
        expect(text).toContain(`        state B2 // comment
        choice Choice1
        B1 -> B2 : next`);
    });

    test('indentation ignores block comments', async () => {
        const text = '/*\n * comment\n */\nstatemachine M {\n  [*] -> A\n  state A\n}\n';
        const { text: result } = await edit(text, (e, f) => e.addVertex(f('A') as ast.State, 'state', 'B'));
        expect(result).toContain('  state A {\n    state B\n  }');
    });

    test('add state to empty body', async () => {
        const { text } = await edit('statemachine M {}', (e, _f, m) => e.addVertex(m, 'state', 'X'));
        expect(text).toBe(`statemachine M {\n    state X\n}`);
    });

    test('rejects duplicate names', async () => {
        const parsed = await parse(base);
        expect(() => new ModelEditor(base, parsed.model).addVertex(parsed.model, 'state', 'A')).toThrow(`A state named 'A' already exists here.`);
        expect(() => new ModelEditor(base, parsed.model).addVertex(parsed.model, 'state', 'state')).toThrow('is not a valid name');
    });

    test('add transition between nested states', async () => {
        const { text, parsed } = await edit(base, (e, f) => e.addTransition(f('B2'), f('A'), 'reset [x > 1] / log("x")'));
        expect(text).toContain(`    A -> B : go\n    B2 -> A : reset [x > 1] / log("x")\n}`);
        const t = parsed.model.transitions[2];
        expect(t.spec?.effect?.statements).toHaveLength(1);
    });

    test('add transition within composite state', async () => {
        const { text } = await edit(base, (e, f) => e.addTransition(f('B2'), f('B1')));
        expect(text).toContain(`        B1 -> B2 : next\n        B2 -> B1\n    }`);
    });

    test('add final transition', async () => {
        const { text } = await edit(base, (e, f) => e.addTransition(f('B2'), { finalOf: f('B') as ast.State }));
        expect(text).toContain(`        B2 -> [*]\n    }`);
    });

    test('set initial replaces the existing target', async () => {
        const { text } = await edit(base, (e, f) => e.setInitial(f('B2')));
        expect(text).toContain(`        [*] -> B2\n`);
    });

    test('rename updates references', async () => {
        const { text } = await edit(base, (e, f) => e.renameVertex(f('B2'), 'Done'));
        expect(text).toContain('state Done // comment');
        expect(text).toContain('B1 -> Done : next');
    });

    test('delete state removes its transitions', async () => {
        const { text } = await edit(base, (e, f) => e.deleteElements([f('B')]));
        expect(text.substring(text.indexOf('    [*] -> A'))).toBe(`    [*] -> A

    state A {
        entry / a()
    }

}
`);
    });

    test('deleting all members collapses the body', async () => {
        const { text } = await edit(base, (e, f) => e.deleteElements([f('B1'), f('B2')]));
        expect(text).toContain(`    state B\n\n    A -> B : go`);
    });

    test('delete initial pseudo state', async () => {
        const { text } = await edit(base, (e, f) => e.deleteElements([{ initialOf: f('B') as ast.State }]));
        expect(text).not.toContain('[*] -> B1');
    });

    test('move state into another state', async () => {
        const { text, parsed } = await edit(base, (e, f) => e.moveVertex(f('A'), f('B') as ast.State));
        expect(text).toContain(`        state B2 // comment
        state A {
            entry / a()
        }
        B1 -> B2 : next`);
        expect(parsed.diagnostics.filter(d => d.severity === 1)).toEqual([]);
    });

    test('move state out of a composite state', async () => {
        const { text } = await edit(base, (e, f, m) => e.moveVertex(f('B2'), m));
        expect(text).toContain(`        B1 -> B2 : next\n    }\n    state B2 // comment\n\n    A -> B : go`);
    });

    test('cannot move state into itself', async () => {
        const parsed = await parse(base);
        const b = parsed.model.vertices[1] as ast.State;
        expect(() => new ModelEditor(base, parsed.model).moveVertex(b, b.vertices[0] as ast.State)).toThrow('into itself');
    });

    test('state actions', async () => {
        let { text } = await edit(base, (e, f) => e.setStateAction(f('A') as ast.State, 'exit', 'b()'));
        expect(text).toContain(`        entry / a()\n        exit / b()\n    }`);
        ({ text } = await edit(text, (e, f) => e.setStateAction(f('A') as ast.State, 'entry', '')));
        expect(text).toContain(`    state A {\n        exit / b()\n    }`);
        ({ text } = await edit(text, (e, f) => e.setStateAction(f('B2') as ast.State, 'entry', 'x = 1; b()')));
        expect(text).toContain(`        state B2 {\n            entry / x = 1; b()\n        } // comment`);
    });

    test('state description', async () => {
        let { text } = await edit(base, (e, f) => e.setStateDescription(f('A') as ast.State, 'The A state'));
        expect(text).toContain('state A "The A state" {');
        ({ text } = await edit(text, (e, f) => e.setStateDescription(f('A') as ast.State, undefined)));
        expect(text).toContain('state A {');
    });

    test('update transition label', async () => {
        const { text } = await edit(base, (e, _f, m) => e.updateTransitionLabel(m.transitions[1], 'start / init()'));
        expect(text).toContain('A -> B : start / init()\n');
        const { text: cleared } = await edit(base, (e, _f, m) => e.updateTransitionLabel(m.transitions[1], ''));
        expect(cleared).toContain('    A -> B\n}');
    });

    test('add region wraps existing content', async () => {
        const { text, parsed } = await edit(base, (e, f) => e.addRegion(f('B') as ast.State));
        expect(text).toContain(`    state B {
        region {
            [*] -> B1
            state B1
            state B2 // comment
            B1 -> B2 : next
        }
        region {
        }
    }`);
        expect((parsed.model.vertices[1] as ast.State).regions).toHaveLength(2);
    });
});

describe('qualified names', () => {
    test('rename updates qualified references', async () => {
        const text = `statemachine M {
    [*] -> A
    state A { [*] -> X state X }
    state B { [*] -> X state X }
    B.X -> A.X
    A.X -> B
}`;
        const { text: result } = await edit(text, (e, f, m) => e.renameVertex((m.vertices[0] as ast.State), 'Alpha'));
        expect(result).toContain('B.X -> Alpha.X');
        expect(result).toContain('Alpha.X -> B');
        expect(result).toContain('[*] -> Alpha');
    });

    test('new transitions use the shortest unambiguous name', async () => {
        const text = `statemachine M {
    [*] -> A
    state A { [*] -> X state X }
    state B { [*] -> X state X }
}`;
        const parsed = await parse(text);
        const a = parsed.model.vertices[0] as ast.State;
        const b = parsed.model.vertices[1] as ast.State;
        const result = applyEdits(text, new ModelEditor(text, parsed.model).addTransition(a.vertices[0], b.vertices[0]).edits);
        expect(result).toContain('A.X -> B.X');
    });
});

describe('pseudo states', () => {
    for (const kind of ['sync', 'entry', 'exit'] as const) {
        test(`add ${kind}`, async () => {
            const { text, result } = await edit(base, (e, f) => e.addVertex(f('B') as ast.State, kind));
            const name = { sync: 'Sync1', entry: 'Entry1', exit: 'Exit1' }[kind];
            expect(result.createdName).toBe(name);
            expect(text).toContain(`        state B2 // comment\n        ${kind} ${name}\n`);
            expect(text.substring(result.selectOffset!)).toMatch(new RegExp(`^${kind} ${name}`));
        });
    }
});

describe('definition section', () => {
    test('add declarations to the existing interface', async () => {
        let { text } = await edit(base, e => e.addDeclaration({ kind: 'out event', name: 'done', type: 'integer' }));
        expect(text).toContain(`        operation log(msg : string) : void\n        out event done : integer\n\n    [*] -> A`);
        ({ text } = await edit(text, e => e.addDeclaration({ kind: 'var', name: 'count', type: 'integer', value: '0' })));
        expect(text).toContain(`        out event done : integer\n        var count : integer = 0\n`);
        ({ text } = await edit(text, e => e.addDeclaration({ kind: 'operation', name: 'beep', type: 'void' })));
        expect(text).toContain(`        operation beep() : void\n`);
    });

    test('internal events create the internal scope', async () => {
        const { text, parsed } = await edit(base, e => e.addDeclaration({ kind: 'internal event', name: 'tick' }));
        expect(text).toContain(`        operation log(msg : string) : void\n\n    internal:\n        event tick\n\n    [*] -> A`);
        expect(parsed.model.scopes).toHaveLength(2);
    });

    test('creates the interface in a machine without definition section', async () => {
        const { text, parsed } = await edit(`statemachine M {\n    [*] -> A\n    state A\n}\n`, e => e.addDeclaration({ kind: 'in event', name: 'go' }));
        expect(text).toBe(`statemachine M {\n    interface:\n        in event go\n\n    [*] -> A\n    state A\n}\n`);
        expect(parsed.model.scopes[0].declarations[0].name).toBe('go');
    });

    test('the unnamed interface is inserted before other scopes', async () => {
        const source = `statemachine M {\n    @EventDriven\n\n    internal:\n        var x : integer\n\n    state A\n}\n`;
        const { text } = await edit(source, e => e.addDeclaration({ kind: 'in event', name: 'go' }));
        expect(text).toBe(`statemachine M {\n    @EventDriven\n\n    interface:\n        in event go\n\n    internal:\n        var x : integer\n\n    state A\n}\n`);
    });

    test('named interfaces and empty scopes', async () => {
        const source = `statemachine M {\n    interface:\n    state A\n}\n`;
        let { text } = await edit(source, e => e.addDeclaration({ kind: 'in event', name: 'go' }));
        expect(text).toBe(`statemachine M {\n    interface:\n        in event go\n    state A\n}\n`);
        ({ text } = await edit(text, e => e.addDeclaration({ kind: 'in event', name: 'request', scope: 'Pedestrian' })));
        expect(text).toContain(`        in event go\n\n    interface Pedestrian:\n        in event request\n    state A`);
    });

    test('rejects duplicates and invalid names', async () => {
        const parsed = await parse(base);
        const editor = new ModelEditor(base, parsed.model);
        expect(() => editor.addDeclaration({ kind: 'in event', name: 'go' })).toThrow(`'go' is already declared.`);
        expect(() => editor.addDeclaration({ kind: 'var', name: '1x' })).toThrow('not a valid name');
        expect(() => editor.addDeclaration({ kind: 'var', name: 'y', type: 'in' })).toThrow('not a valid type');
    });

    test('new states are added after the definition section', async () => {
        const { text } = await edit(`statemachine M {\n    interface:\n        in event go\n}\n`, (e, _f, m) => e.addVertex(m, 'state', 'A'));
        expect(text).toBe(`statemachine M {\n    interface:\n        in event go\n\n    state A\n}\n`);
    });

    test('new states keep the namespace', async () => {
        const { text } = await edit(`statemachine M {\n    namespace a.b\n}\n`, (e, _f, m) => e.addVertex(m, 'state', 'A'));
        expect(text).toBe(`statemachine M {\n    namespace a.b\n\n    state A\n}\n`);
    });
});
