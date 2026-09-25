import { describe, expect, test } from 'vitest';
import * as ast from '../src/generated/ast.js';
import { applyEdits, ModelEditor, parseTransitionLabel, type EditResult } from '../src/edit/model-edits.js';
import { allVertices } from '../src/model-utils.js';
import { parse } from './helpers.js';

const base = `statemachine M {
    [*] -> A

    state A {
        entry / "a()"
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
        expect(() => new ModelEditor(base, parsed.model).addVertex(parsed.model, 'state', 'A')).toThrow(`A state named 'A' already exists.`);
        expect(() => new ModelEditor(base, parsed.model).addVertex(parsed.model, 'state', 'state')).toThrow('is not a valid name');
    });

    test('add transition between nested states', async () => {
        const { text, parsed } = await edit(base, (e, f) => e.addTransition(f('B2'), f('A'), { event: 'reset', guard: 'x > 1', effect: 'log("x")' }));
        expect(text).toContain(`    A -> B : go\n    B2 -> A : reset ["x > 1"] / "log(\\"x\\")"\n}`);
        const t = parsed.model.transitions[2];
        expect(t.effect).toBe('log("x")');
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
        expect(text).toBe(`statemachine M {
    [*] -> A

    state A {
        entry / "a()"
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
            entry / "a()"
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
        expect(text).toContain(`        entry / "a()"\n        exit / "b()"\n    }`);
        ({ text } = await edit(text, (e, f) => e.setStateAction(f('A') as ast.State, 'entry', '')));
        expect(text).toContain(`    state A {\n        exit / "b()"\n    }`);
        ({ text } = await edit(text, (e, f) => e.setStateAction(f('B2') as ast.State, 'do', 'work()')));
        expect(text).toContain(`        state B2 {\n            do / "work()"\n        } // comment`);
    });

    test('state description', async () => {
        let { text } = await edit(base, (e, f) => e.setStateDescription(f('A') as ast.State, 'The A state'));
        expect(text).toContain('state A "The A state" {');
        ({ text } = await edit(text, (e, f) => e.setStateDescription(f('A') as ast.State, undefined)));
        expect(text).toContain('state A {');
    });

    test('update transition label', async () => {
        const { text } = await edit(base, (e, _f, m) => e.updateTransitionLabel(m.transitions[1], { event: 'start', effect: 'init()' }));
        expect(text).toContain('A -> B : start / "init()"\n');
        const { text: cleared } = await edit(base, (e, _f, m) => e.updateTransitionLabel(m.transitions[1], {}));
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

describe('parseTransitionLabel', () => {
    test('full label', () => {
        expect(parseTransitionLabel('open [a[0] > 1] / doIt(1)')).toEqual({ event: 'open', guard: 'a[0] > 1', effect: 'doIt(1)' });
    });
    test('guard only', () => {
        expect(parseTransitionLabel(' [ready]')).toEqual({ guard: 'ready' });
    });
    test('invalid', () => {
        expect(parseTransitionLabel('a b')).toContain('Unexpected text');
    });
});
