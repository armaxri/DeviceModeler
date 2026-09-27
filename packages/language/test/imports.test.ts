import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeFileSystem } from 'langium/node';
import { describe, expect, test } from 'vitest';
import { HsmModelLoader } from '../src/hsm-document.js';
import { createHsmServices } from '../src/hsm-module.js';
import { importKind, importedMachines, instanceMachine, instanceVariables, resolvedImports, submachineOf } from '../src/imports.js';
import { inferType } from '../src/hsm-typesystem.js';
import { StatechartInterpreter } from '../src/simulation/interpreter.js';
import { HsmTestWorkspace } from '../src/testing/test-workspace.js';
import * as ast from '../src/generated/ast.js';
import { errors, example, parse, warnings } from './helpers.js';

const MOTOR = `
statemachine Motor {
    interface:
        in event start
        out event stopped
        out event level : integer
        var speed : integer = 0
        const MAX : integer = 10
        var readonly id : integer = 7
        operation setPwm(duty : integer) : void
    interface Diag:
        var errors : integer = 0
    internal:
        var secret : integer = 0
        event tick
    entry Run
    exit Done
    [*] -> Off
    state Off
    state On {
        state Slow
        state Fast
        [*] -> Slow
    }
    Run -> On
    Off -> On : start / raise level : speed; setPwm(1); secret = 1
    On -> Done : tick
    On -> Off : start [secret > 0] / raise stopped; raise tick
}
`;

function door(body: string, declarations = ''): string {
    return `
statemachine Door {
    import "motor.hsm"
    interface:
        in event open
        in event close
        var x : integer = 0
        var flag : boolean = false
${declarations}
    internal:
        var motor : Motor
    [*] -> Closed
    state Closed
    state Moving : motor
    state Done
    Closed -> Moving : open
    Moving -> Closed : close
${body}
}
`;
}

async function check(body: string, declarations = '') {
    return parse(door(body, declarations), { 'motor.hsm': MOTOR });
}

describe('imports', () => {
    test('kinds of import paths', () => {
        expect(importKind('motor.hsm')).toBe('hsm');
        expect(importKind('sub/Motor.HSM')).toBe('hsm');
        expect(importKind('types.h')).toBe('header');
        expect(importKind('types.hpp')).toBe('header');
        expect(importKind('motor.sct')).toBe('unsupported');
    });

    test('an imported state machine is a type, its variables are instances', async () => {
        const parsed = await check('');
        expect(errors(parsed)).toEqual([]);
        const machine = parsed.model;
        expect([...importedMachines(machine).keys()]).toEqual(['Motor']);
        const [motor] = instanceVariables(machine);
        expect(motor.name).toBe('motor');
        expect(instanceMachine(motor)?.name).toBe('Motor');
        const moving = machine.vertices.find(v => v.name === 'Moving') as ast.State;
        expect(submachineOf(moving)?.instance).toBe(motor);
        expect(parsed.imported.map(i => path.basename(i.uri))).toEqual(['motor.hsm']);
    });

    test("itemis CREATE form 'import: \"a\" \"b\"' and header imports", async () => {
        const parsed = await parse(`
statemachine Door {
    namespace door
    import: "motor.hsm" "types.h"
    internal:
        var motor : Motor
    [*] -> Moving
    state Moving : motor
}
`, { 'motor.hsm': MOTOR });
        expect(errors(parsed)).toEqual([]);
        expect(resolvedImports(parsed.model).map(i => i.kind)).toEqual(['hsm', 'header']);
        expect(parsed.diagnostics.filter(d => d.severity === 3).map(d => d.message))
            .toContain(`C/C++ header imports are not supported yet; 'types.h' is ignored.`);
    });

    test('missing files, unsupported files, cycles and duplicate names', async () => {
        const missing = await parse('statemachine A {\n    import "nothing.hsm"\n    [*] -> S\n    state S\n}');
        expect(errors(missing)).toEqual([expect.stringMatching(/^Cannot resolve the import 'nothing.hsm': the file '.*nothing.hsm' was not found.$/)]);
        const unsupported = await parse('statemachine A {\n    import "a.sct"\n    [*] -> S\n    state S\n}');
        expect(errors(unsupported)[0]).toContain(`Cannot import 'a.sct'`);
        const cycle = await parse('statemachine A {\n    import "b.hsm"\n    [*] -> S\n    state S\n}', {
            'b.hsm': 'statemachine B {\n    import "c.hsm"\n    [*] -> S\n    state S\n}',
            'c.hsm': 'statemachine C {\n    import "b.hsm"\n    [*] -> S\n    state S\n}'
        });
        expect(errors(cycle)).toEqual([]);
        expect(cycle.imported.flatMap(i => i.diagnostics.filter(d => d.severity === 1).map(d => d.message)))
            .toEqual(['Import cycle: B -> C -> B. State machines cannot import each other.', 'Import cycle: C -> B -> C. State machines cannot import each other.']);
        const self = await loadFiles({ 'a.hsm': 'statemachine A {\n    import "a.hsm"\n    [*] -> S\n    state S\n}' }, 'a.hsm');
        expect(errors(self)).toEqual([`The state machine 'A' cannot import itself.`]);
        const duplicate = await parse('statemachine A {\n    import "b.hsm"\n    import "sub/b.hsm"\n    import "b.hsm"\n    [*] -> S\n    state S\n}', {
            'b.hsm': 'statemachine B {\n    [*] -> S\n    state S\n}',
            'sub/b.hsm': 'statemachine B {\n    [*] -> S\n    state S\n}'
        });
        expect(errors(duplicate)).toEqual([`Duplicate state machine name 'B': it is also imported from 'b.hsm'.`]);
        expect(warnings(duplicate)).toContain(`'b.hsm' is imported more than once.`);
        const sameName = await parse('statemachine B {\n    import "b.hsm"\n    [*] -> S\n    state S\n}', { 'b.hsm': 'statemachine B {\n    [*] -> S\n    state S\n}' });
        expect(errors(sameName)).toEqual([`The imported state machine has the same name as this state machine ('B').`]);
    });

    test('files are loaded relative to the importing file (Node file system)', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-imports-'));
        fs.mkdirSync(path.join(directory, 'parts'));
        fs.writeFileSync(path.join(directory, 'parts', 'motor.hsm'), MOTOR.replace('statemachine Motor {', 'statemachine Motor {\n    import "gear.hsm"'));
        fs.writeFileSync(path.join(directory, 'parts', 'gear.hsm'), 'statemachine Gear {\n    [*] -> S\n    state S\n}');
        const text = door('').replace('import "motor.hsm"', 'import "parts/motor.hsm"');
        const loader = new HsmModelLoader(createHsmServices(NodeFileSystem));
        const parsed = await loader.load(text, pathToFileURL(path.join(directory, 'door.hsm')).toString());
        expect(errors(parsed)).toEqual([]);
        expect(parsed.imported.map(i => path.basename(i.uri)).sort()).toEqual(['gear.hsm', 'motor.hsm']);
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('the example gate.hsm with its motor', async () => {
        const directory = path.resolve(__dirname, '../../../examples/door-with-motor');
        const loader = new HsmModelLoader(createHsmServices(NodeFileSystem));
        const parsed = await loader.load(example('door-with-motor/gate.hsm'), pathToFileURL(path.join(directory, 'gate.hsm')).toString());
        expect(errors(parsed)).toEqual([]);
        expect(warnings(parsed)).toEqual([]);
        const sim = new StatechartInterpreter(parsed.model);
        sim.enter();
        sim.raise('open');
        sim.runCycle();
        sim.runCycle();
        expect(sim.activeStates).toEqual(['Moving', 'motor.Ramping']);
        sim.runFor(1000);
        expect(sim.activeStates).toEqual(['Opened']);
        expect(sim.getVariable('lastSpeed')).toBe(3);
        expect(sim.variables).toMatchObject({ faults: 0, 'motor.speed': 3, 'motor.maxSpeed': 3 });
        expect(() => sim.raise('motor.start')).toThrow(/raised by the state machine/);
    });

    test('unit tests of the example (HsmTestWorkspace loads the imported motor)', async () => {
        const directory = path.resolve(__dirname, '../../../examples/door-with-motor');
        const workspace = new HsmTestWorkspace(createHsmServices(NodeFileSystem));
        const files = ['gate.hsm', 'gate.hsmtest'].map(file => ({ uri: pathToFileURL(path.join(directory, file)).toString(), text: fs.readFileSync(path.join(directory, file), 'utf-8') }));
        const { documents, results } = await workspace.run(files);
        expect(documents.flatMap(d => d.diagnostics.filter(x => x.severity === 1).map(x => x.message))).toEqual([]);
        expect(results.map(r => `${r.name}: ${r.status} ${r.message ?? ''}`.trim())).toEqual([
            'opensWhenTheMotorRuns: passed', 'opensFastThroughTheEntryPoint: passed', 'reportsAJammedMotor: passed', 'keepsTheMotorDataWhenReentered: passed'
        ]);
    });
});

describe('submachine instances: validation', () => {
    test('members of instances', async () => {
        const parsed = await check(`
    Moving -> Done : motor.stopped [motor.speed > motor.MAX && valueof(motor.level) == 1 && active(motor.On) && active(motor.On.Fast) && active(motor.Fast)] / raise motor.start; motor.speed = 3; x = motor.Diag.errors
`);
        expect(errors(parsed)).toEqual([]);
    });

    test('direction of events, internal scope, operations', async () => {
        const parsed = await check(`
    Moving -> Done : motor.start
    Moving -> Closed : [motor.start] / raise motor.stopped
    Closed -> Done : [valueof(motor.level) > 0] / motor.setPwm(1); x = motor.secret
`);
        expect(errors(parsed).sort()).toEqual([
            `The event 'motor.start' cannot be used as a trigger: only the out events of a submachine instance can be observed.`,
            `The in event 'motor.start' of a submachine instance cannot be used as a condition: only its out events can be observed.`,
            `Cannot raise 'motor.stopped': only the in events of a submachine instance can be raised.`,
            `The operation 'motor.setPwm' of a submachine instance cannot be called: operations are implemented by the host of the instance.`,
            `Could not resolve reference to Declaration named 'motor.secret'.`
        ].sort());
    });

    test('instances cannot be assigned, compared or used as values', async () => {
        const parsed = await check(`
    Closed -> Done : [motor == motor] / motor = motor; motor.MAX = 1; motor.id = 2; motor++
`);
        expect(errors(parsed)).toEqual([
            'Cannot compare a value of type state machine instance with a value of type state machine instance.',
            `Cannot assign to the submachine instance 'motor': instances cannot be assigned.`,
            `Cannot assign a value to the constant 'motor.MAX'.`,
            `Cannot assign a value to the readonly variable 'motor.id'.`,
            `Cannot modify the submachine instance 'motor'.`
        ]);
        expect(inferType((parsed.model.transitions.at(-1)!.spec!.guard as ast.BinaryExpression).left)).toBe('instance');
    });

    test('declarations and bindings of instances', async () => {
        const parsed = await parse(`
statemachine Door {
    import "motor.hsm"
    @ChildFirstExecution
    interface:
        in event motorEvent : Motor
        var y : integer = 0
    internal:
        var motor : Motor
        var other : Motor
        const fixed : Motor = 1
        var unbound : Motor
    [*] -> A
    state A : motor
    state B : motor
    state C : y
    state D : other {
        state E
    }
    A -> B : [true]
    B -> C : [true]
    C -> D : [true]
    D -> A : [true] # >Nope
}
`, { 'motor.hsm': MOTOR });
        expect(errors(parsed).sort()).toEqual([
            `The state machine type 'Motor' can only be used as the type of a variable (a submachine instance).`,
            `The submachine instance 'fixed' cannot be a constant; declare it with 'var'.`,
            `The submachine instance 'fixed' cannot have an initial value.`,
            `The submachine instance 'motor' is already bound to the state 'A'. An instance can be bound to one state only.`,
            `'y' is not a submachine instance: its type must be an imported state machine ('var y : Machine').`,
            `The submachine state 'D' cannot have sub states or regions: its sub states are the states of 'other'.`,
            `'A' has no entry point 'Nope'.`
        ].sort());
        expect(warnings(parsed)).toEqual(expect.arrayContaining([
            `The submachine instance 'unbound' is not bound to a state ('state S : unbound'); it never runs.`,
            `The state machine 'Motor' uses @ParentFirstExecution, but its instance 'motor' is executed with @ChildFirstExecution of 'Door'.`
        ]));
    });

    test('entry points and exit nodes of the instance', async () => {
        const parsed = await check(`
    Closed -> Moving : [x > 0] # >Run
    Moving -> Done : # Done>
    Moving -> Closed : # Missing>
`);
        expect(errors(parsed)).toEqual([`'Moving' has no exit node 'Missing'.`]);
    });

    test('an unknown type lists the imported state machines', async () => {
        const parsed = await check('', '        var z : Motr');
        expect(errors(parsed)).toEqual([`Unknown type 'Motr'. Known types are integer, real, boolean, string, void, imported state machines (Motor) and type aliases ('alias Name : type').`]);
    });

    test('changing an imported file updates the importing document (language server)', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-imports-update-'));
        fs.writeFileSync(path.join(directory, 'motor.hsm'), MOTOR);
        const services = createHsmServices(NodeFileSystem);
        const loader = new HsmModelLoader(services);
        const parsed = await loader.load(door(''), pathToFileURL(path.join(directory, 'door.hsm')).toString());
        expect(errors(parsed)).toEqual([]);
        // the motor is renamed: the door is relinked (HsmDocumentBuilder.shouldRelink) and reports the errors
        fs.writeFileSync(path.join(directory, 'motor.hsm'), MOTOR.replace('statemachine Motor {', 'statemachine Engine {'));
        await services.shared.workspace.DocumentBuilder.update([parsed.imported[0].document.uri], []);
        fs.rmSync(directory, { recursive: true, force: true });
        expect(errors({ ...parsed, diagnostics: parsed.document.diagnostics ?? [] })).toEqual([
            `Unknown type 'Motor'. Known types are integer, real, boolean, string, void, imported state machines (Engine) and type aliases ('alias Name : type').`,
            `'motor' is not a submachine instance: its type must be an imported state machine ('var motor : Machine').`
        ]);
    });
});

/** Loads files of a virtual directory (`memory:///<n>/`) and returns the parsed `main` file. */
let directoryCounter = 0;
async function loadFiles(files: Record<string, string>, main: string) {
    const base = `memory:///files-${directoryCounter++}/`;
    const loader = new HsmModelLoader();
    return loader.load(files[main], base + main, { files });
}
