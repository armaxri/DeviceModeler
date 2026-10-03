import { describe, expect, test } from 'vitest';
import type { Diagnostic } from 'vscode-languageserver-types';
import * as ast from '../src/generated/ast.js';
import { isStructureText, MIXED_KINDS_MESSAGE } from '../src/devm-parser.js';
import { StateMachineModelLoader } from '../src/model-loader.js';

/*
 * The `.devm` language: one language for state machine files and structure files (devm.langium).
 */

const loader = new StateMachineModelLoader();
const services = loader.services;
let counter = 0;

async function load(text: string, files?: Record<string, string>) {
    return loader.load(text, `file:///work/devm-${counter++}/main.devm`, { files });
}

const errors = (parsed: { diagnostics: Diagnostic[] }) => parsed.diagnostics.filter(d => d.severity === 1).map(d => d.message);

const MOTOR = 'statemachine Motor {\n    interface:\n        in event start\n    [*] -> Off\n    state Off\n}\n';
const TYPES = 'struct Position { x : real }\n';

describe('the .devm language: one kind per file', () => {
    test('the kind of a file is decided by its first token', async () => {
        expect((await load(MOTOR)).model.$type).toBe('StateMachine');
        expect((await load(TYPES)).model.$type).toBe('StructureModel');
        expect((await load('/** the motor */\n// comment\n' + MOTOR)).model.$type).toBe('StateMachine');
        expect(isStructureText(MOTOR)).toBe(false);
        expect(isStructureText('/* c */ // d\n' + MOTOR)).toBe(false);
        expect(isStructureText(TYPES)).toBe(true);
        expect(isStructureText('statemachines')).toBe(true);
    });

    test('an empty file is an empty structure file without errors', async () => {
        for (const text of ['', '\n', '// nothing yet\n', '/* nothing */']) {
            const parsed = await load(text);
            expect(parsed.model.$type).toBe('StructureModel');
            expect(ast.isStructureModel(parsed.model) && parsed.model.elements).toEqual([]);
            expect(parsed.hasSyntaxErrors).toBe(false);
            expect(isStructureText(text)).toBe(true);
        }
    });

    test('a state machine and structure elements in one file are reported', async () => {
        const after = await load(MOTOR + 'struct Position { x : real }\n');
        expect(after.model.$type).toBe('StateMachine');
        expect(errors(after)).toEqual([`${MIXED_KINDS_MESSAGE}: \`struct\` cannot follow the state machine (write structure elements into a file of their own).`]);
        const before = await load(TYPES + MOTOR);
        expect(before.model.$type).toBe('StructureModel');
        expect(errors(before)).toEqual([`${MIXED_KINDS_MESSAGE}: a state machine cannot follow structure elements (write it into a file of its own).`]);
    });

    test('a state machine with a syntax error stays a state machine', async () => {
        const parsed = await load('statemachine Door {\n    state A\n    A -> \n}\n');
        expect(parsed.model.$type).toBe('StateMachine');
        expect((parsed.model as ast.StateMachine).name).toBe('Door');
        expect(parsed.hasSyntaxErrors).toBe(true);
    });

    test('the keywords of the other kind are names', async () => {
        const machine = await load('statemachine M {\n    interface:\n        var system : integer\n        in event connect\n        var inout : boolean\n'
            + '    [*] -> component\n    state component\n    component -> thread : connect / system = 1\n    state thread\n}\n');
        expect(errors(machine)).toEqual([]);
        const structure = await load('struct Sample { state : integer  entry : boolean  in : real }\n'
            + 'component C { in async in : Sample out sync out : Sample in async interface out async event }\n');
        expect(errors(structure)).toEqual([]);
        const fields = (structure.model as ast.StructureModel).elements.filter(ast.isStructDeclaration).flatMap(s => s.fields.map(f => f.name));
        expect(fields).toEqual(['state', 'entry', 'in']);
        const ports = (structure.model as ast.StructureModel).elements.filter(ast.isComponent).flatMap(c => c.ports.map(p => `${p.direction} ${p.name}`));
        expect(ports).toEqual(['in in', 'out out', 'in interface', 'out event']);
    });

    test('syntax errors list the keywords accepted as names as ID', async () => {
        const parsed = await load('statemachine {\n}\n');
        const message = errors(parsed)[0];
        expect(message).toContain('[ID]');
        expect(message).not.toContain('component');
    });

    test('imports: a state machine imports state machine files, not structure files', async () => {
        const text = 'statemachine Gate {\n    import "types.devm"\n    import "motor.devm"\n    [*] -> A\n    state A\n}\n';
        const parsed = await load(text, { 'types.devm': TYPES, 'motor.devm': MOTOR });
        expect(errors(parsed)).toEqual(["Cannot import 'types.devm': it is a structure file; a state machine imports state machine files and C/C++ headers."]);
    });

    test('imports of structure files: structure files and state machine files by their content', async () => {
        const text = 'import "types.devm"\nimport "motor.devm"\nstruct Pose { p : Position }\ncomponent C {\n    behavior Motor\n    in async start\n}\n';
        const parsed = await load(text, { 'types.devm': TYPES, 'motor.devm': MOTOR });
        expect(errors(parsed)).toEqual([]);
        const missing = await load('import "nowhere.devm"\n');
        expect(errors(missing)[0]).toMatch(/^Cannot resolve the import 'nowhere.devm': the file '.*nowhere.devm' was not found.$/);
    });

    test('the behavior of a component is a state machine file', async () => {
        const ok = await load('component C {\n    behavior "motor.devm"\n    in async start\n}\n', { 'motor.devm': MOTOR });
        expect(errors(ok)).toEqual([]);
        const structure = await load('component C {\n    behavior "types.devm"\n}\n', { 'types.devm': TYPES });
        expect(errors(structure)).toEqual(["The behavior of a component is a state machine file: 'types.devm' is a structure file."]);
        const other = await load('component C {\n    behavior "motor.sm"\n}\n');
        expect(errors(other)).toEqual(["The behavior of a component is a state machine file ('.devm'), not 'motor.sm'."]);
    });

    test('completion does not propose the keywords of the other kind', async () => {
        const parsed = await load('statemachine M {\n    interface:\n        var x : integer\n    [*] -> A\n    state A\n    A -> A : / x = \n}\n');
        const list = await services.Devm.lsp.CompletionProvider!.getCompletion(parsed.document, {
            textDocument: { uri: parsed.document.uri.toString() }, position: { line: 5, character: 18 }
        });
        const labels = list?.items.map(i => i.label) ?? [];
        expect(labels).toContain('x');
        expect(labels).not.toContain('component');
        expect(labels).not.toContain('thread');
    });

    test('formatting dispatches on the kind of the file', async () => {
        const format = async (text: string) => {
            const parsed = await load(text);
            const edits = await services.Devm.lsp.Formatter!.formatDocument(parsed.document, {
                textDocument: { uri: parsed.document.uri.toString() }, options: { tabSize: 4, insertSpaces: true }
            });
            return edits.length;
        };
        expect(await format('statemachine M {\n[*]->A\nstate A\n}\n')).toBeGreaterThan(0);
        expect(await format('component C {\nin async start:integer\n}\n')).toBeGreaterThan(0);
    });
});
