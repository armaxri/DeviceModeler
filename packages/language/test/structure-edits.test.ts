import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import * as ast from '../src/generated/ast.js';
import { compositeInstances } from '../src/structure-model.js';
import { StructureWorkspace, routeContinuations, routeIdsAt } from '../src/structure-workspace.js';
import { StructureEditor, structureRenameEdits, planConnection, IncompatiblePortsError, type PortEnd } from '../src/edit/structure-edits.js';
import { applyEdits, EditError, type EditResult } from '../src/edit/model-edits.js';
import { StructureModelLoader } from '../src/model-loader.js';

const loader = new StructureModelLoader();
const DEVICE_DIR = path.resolve(__dirname, '../../../examples/device');
const deviceFile = (name: string) => fs.readFileSync(path.join(DEVICE_DIR, name), 'utf-8');
const DEVICE_FILES = ['types.devm', 'components.devm', 'drive-unit.devm', 'garage-door.devm', 'controller.devm', 'drive.devm', 'door_types.h'];

let counter = 0;

/** Loads a structure file of the device example (with the other files of the example). */
async function load(text: string, name = 'garage-door.devm') {
    const files: Record<string, string> = {};
    for (const file of DEVICE_FILES) {
        if (file !== name) {
            files[file] = deviceFile(file);
        }
    }
    return loader.load(text, `file:///work/edits-${counter++}/${name}`, { files });
}

/** Applies an edit to a file of the device example, checks that the result parses without errors and returns the new text. */
async function edit(name: string, op: (editor: StructureEditor, model: ast.StructureModel) => EditResult, text = deviceFile(name)) {
    const parsed = await load(text, name);
    expect(parsed.hasSyntaxErrors).toBe(false);
    const result = op(new StructureEditor(text, parsed.model), parsed.model);
    const changed = applyEdits(text, result.edits);
    const reparsed = await load(changed, name);
    expect(reparsed.hasSyntaxErrors, changed).toBe(false);
    return { text: changed, result, parsed: reparsed, errors: reparsed.diagnostics.filter(d => d.severity === 1).map(d => d.message) };
}

function structure(model: ast.StructureModel, name: string): ast.CompositeType {
    return model.elements.find((e): e is ast.CompositeType => ast.isCompositeType(e) && e.name === name)!;
}

function instance(s: ast.CompositeType, name: string): ast.ComponentInstance {
    return compositeInstances(s).find(i => i.name === name)!;
}

function end(s: ast.CompositeType, text: string): PortEnd {
    const [first, second] = text.split('.');
    if (second === undefined) {
        return { port: s.ports.find(p => p.name === first)! };
    }
    const part = instance(s, first);
    return { instance: part, port: part.type.ref!.ports.find(p => p.name === second)! };
}

describe('structure edits: threads and instances', () => {
    test('add a thread after the last thread', async () => {
        const { text, result } = await edit('garage-door.devm', (e, m) => e.addThread(structure(m, 'GarageDoor')));
        expect(result.createdName).toBe('Thread1');
        expect(text).toContain(`        diag : Diagnosis
    }
    thread Thread1 {
    }
    // a subsystem: outside of the threads, its parts run in the threads of DriveUnit
    drive : DriveUnit`);
        expect(text.substring(result.selectOffset!)).toMatch(/^thread Thread1/);
    });

    test('add a thread with annotations', async () => {
        const { text } = await edit('drive-unit.devm', (e, m) => e.addThread(structure(m, 'DriveUnit'), 'SafetyTask', { priority: '9', period: '5 ms' }));
        expect(text).toContain(`        switches : EndSwitches
    }
    @priority(9) @period(5 ms)
    thread SafetyTask {
    }
`);
    });

    test('add an instance of a component into a thread, of a subsystem outside of threads', async () => {
        const inThread = await edit('garage-door.devm', (e, m) => e.addInstance(structure(m, 'GarageDoor'), 'Buzzer', { thread: structure(m, 'GarageDoor').threads[1] }));
        expect(inThread.result.createdName).toBe('buzzer1');
        expect(inThread.text).toContain(`        diag : Diagnosis
        buzzer1 : Buzzer
    }`);
        expect(inThread.text.substring(inThread.result.selectOffset!)).toMatch(/^buzzer1 : Buzzer/);
        const subsystem = await edit('garage-door.devm', (e, m) => e.addInstance(structure(m, 'GarageDoor'), 'DriveUnit', { name: 'drive2' }));
        expect(subsystem.text).toContain(`    drive : DriveUnit
    drive2 : DriveUnit

    connect door.up -> drive.up`);
        // a component instance needs a thread, a subsystem instance must not be in one
        const parsed = await load(deviceFile('garage-door.devm'));
        const editor = new StructureEditor(parsed.text, parsed.model);
        const s = structure(parsed.model, 'GarageDoor');
        expect(() => editor.addInstance(s, 'PwmDriver')).toThrow("'PwmDriver' is a component: its instances run in a thread – add the instance to a thread.");
        expect(() => editor.addInstance(s, 'DriveUnit', { thread: s.threads[0] })).toThrow(/'DriveUnit' is a subsystem: its instances are placed outside of the threads/);
    });

    test('add an instance into an empty thread', async () => {
        const text = 'import "components.devm"\nsystem S {\n    thread T { }\n}\n';
        const { text: result } = await edit('main.devm', (e, m) => e.addInstance(structure(m, 'S'), 'Buzzer', { thread: structure(m, 'S').threads[0] }), text);
        expect(result).toBe('import "components.devm"\nsystem S {\n    thread T {\n        buzzer : Buzzer\n    }\n}\n');
    });

    test('names must be unique and valid', async () => {
        const parsed = await load(deviceFile('garage-door.devm'));
        const editor = new StructureEditor(parsed.text, parsed.model);
        expect(() => editor.addThread(structure(parsed.model, 'GarageDoor'), 'door')).toThrow(EditError);
        expect(() => editor.addThread(structure(parsed.model, 'GarageDoor'), 'thread')).toThrow(/not a valid name/);
        const s = structure(parsed.model, 'GarageDoor');
        expect(() => editor.addInstance(s, 'Buzzer', { name: 'IoTask', thread: s.threads[0] })).toThrow(/already has/);
    });

    test('move an instance between threads (with its comment)', async () => {
        const text = deviceFile('garage-door.devm').replace('        buzzer : Buzzer\n', '        // beeps\n        buzzer : Buzzer // the alarm\n');
        const { text: result, errors } = await edit('garage-door.devm', (e, m) => {
            const s = structure(m, 'GarageDoor');
            return e.moveInstance(instance(s, 'buzzer'), s.threads[1]);
        }, text);
        expect(errors).toEqual([]);
        expect(result).toContain(`    thread ControlTask {
        door : DoorController
    }`);
        expect(result).toContain(`        diag : Diagnosis
        // beeps
        buzzer : Buzzer // the alarm
    }`);
    });

    test('instances of components stay in threads, instances of subsystems outside of them', async () => {
        const parsed = await load(deviceFile('garage-door.devm'));
        const editor = new StructureEditor(parsed.text, parsed.model);
        const s = structure(parsed.model, 'GarageDoor');
        expect(() => editor.moveInstance(instance(s, 'sensor'), s)).toThrow("'sensor' is an instance of the component PositionSensor: it runs in a thread – move it into another thread.");
        expect(() => editor.moveInstance(instance(s, 'drive'), s.threads[0])).toThrow(/'drive' is an instance of the subsystem DriveUnit: it is placed outside of the threads/);
        expect(editor.moveInstance(instance(s, 'drive'), s).edits).toEqual([]);
        // an invalid model: a subsystem instance in a thread can be moved out of it
        const text = 'import "drive-unit.devm"\nsystem S {\n    thread T {\n        d : DriveUnit\n    }\n}\n';
        const out = await edit('main.devm', (e, m) => e.moveInstance(instance(structure(m, 'S'), 'd'), structure(m, 'S')), text);
        expect(out.text).toBe('import "drive-unit.devm"\nsystem S {\n    thread T {\n    }\n\n    d : DriveUnit\n}\n');
    });

    test('move an instance assigned by name', async () => {
        const text = 'import "components.devm"\nsystem S {\n    thread A {\n        b\n    }\n    thread B { }\n    b : Buzzer\n}\n';
        const { text: result } = await edit('main.devm', (e, m) => {
            const s = structure(m, 'S');
            return e.moveInstance(instance(s, 'b'), s.threads[1]);
        }, text);
        expect(result).toBe('import "components.devm"\nsystem S {\n    thread A {\n    }\n    thread B {\n        b : Buzzer\n    }\n}\n');
    });

    test('change the type of an instance', async () => {
        const { text } = await edit('garage-door.devm', (e, m) => e.setInstanceType(instance(structure(m, 'GarageDoor'), 'buzzer'), 'Diagnosis'));
        expect(text).toContain('        buzzer : Diagnosis\n');
    });
});

describe('structure edits: connections', () => {
    test('connect an out port to an in port, swapped if drawn the other way', async () => {
        const text = deviceFile('garage-door.devm').replace('    connect door.alarm -> buzzer.alarm\n', '');
        const { text: result, result: r, errors } = await edit('garage-door.devm', (e, m) => {
            const s = structure(m, 'GarageDoor');
            return e.addConnection(s, end(s, 'buzzer.alarm'), end(s, 'door.alarm'));
        }, text);
        expect(errors).toEqual([]);
        expect((r as { plan: { swapped: boolean } }).plan.swapped).toBe(true);
        expect(result).toContain(`    connect door.errors -> diag.errors
    connect door.alarm -> buzzer.alarm
    delegate open -> door.open`);
        expect(result.substring(r.selectOffset!)).toMatch(/^connect door.alarm -> buzzer.alarm/);
    });

    test('inout ports: connected in the order they were chosen', async () => {
        const text = deviceFile('garage-door.devm').replace('    connect door.errors -> diag.errors\n', '');
        const { text: result, result: r, errors } = await edit('garage-door.devm', (e, m) => {
            const s = structure(m, 'GarageDoor');
            return e.addConnection(s, end(s, 'diag.errors'), end(s, 'door.errors'));
        }, text);
        expect(errors).toEqual([]);
        expect((r as { plan: { swapped: boolean } }).plan.swapped).toBe(false);
        expect(result).toContain('    connect door.cycles -> diag.cycles\n    connect diag.errors -> door.errors\n');
        // connected already (in the other order)
        const parsed = await load(deviceFile('garage-door.devm'));
        const s = structure(parsed.model, 'GarageDoor');
        expect(() => planConnection(s, end(s, 'diag.errors'), end(s, 'door.errors'))).toThrow(/already connected/);
    });

    test('boundary port and port of a part: a delegation in the direction of the data', async () => {
        const text = deviceFile('drive-unit.devm').replace('    delegate up -> motor.up\n', '').replace('    delegate motor.stopped -> stopped\n', '');
        const { text: result } = await edit('drive-unit.devm', (e, m) => {
            const s = structure(m, 'DriveUnit');
            return e.addConnection(s, end(s, 'motor.up'), end(s, 'up'));
        }, text);
        expect(result).toContain('    delegate motor.blocked -> blocked\n    delegate up -> motor.up\n}');
        const { text: out } = await edit('drive-unit.devm', (e, m) => {
            const s = structure(m, 'DriveUnit');
            return e.addConnection(s, end(s, 'stopped'), end(s, 'motor.stopped'));
        }, result);
        expect(out).toContain('    delegate up -> motor.up\n    delegate motor.stopped -> stopped\n}');
    });

    test('invalid and incompatible connections are refused', async () => {
        const parsed = await load(deviceFile('garage-door.devm'));
        const s = structure(parsed.model, 'GarageDoor');
        expect(() => planConnection(s, end(s, 'door.open'), end(s, 'buzzer.alarm'))).toThrow('Both ports are in ports – the data flows from an out port to an in port.');
        expect(() => planConnection(s, end(s, 'door.up'), end(s, 'door.alarm'))).toThrow(/same part/);
        expect(() => planConnection(s, end(s, 'open'), end(s, 'report'))).toThrow(/Two boundary ports/);
        expect(() => planConnection(s, end(s, 'open'), end(s, 'door.up'))).toThrow(
            "The boundary port 'open' is an in port, 'door.up' an out port – a boundary port is delegated to a port of a part with the same direction.");
        expect(() => planConnection(s, end(s, 'door.up'), end(s, 'drive.up'))).toThrow(/already connected/);
        expect(() => planConnection(s, end(s, 'door.errors'), end(s, 'diag.cycles'))).toThrow(
            "'door.errors' is an inout port (shared data): it is connected with inout ports only, 'diag.cycles' is an in port.");
        const refused = (a: string, b: string) => {
            try {
                planConnection(s, end(s, a), end(s, b));
            } catch (error) {
                expect(error).toBeInstanceOf(IncompatiblePortsError);
                return (error as IncompatiblePortsError).message;
            }
            throw new Error(`${a} and ${b} were not refused`);
        };
        expect(refused('door.alarm', 'diag.cycles')).toBe(
            'door.alarm (out async) cannot be connected to diag.cycles (in sync integer): door.alarm is an async port (an event), '
            + 'diag.cycles is a sync port (data) – sync ports are connected with sync ports, async ports with async ports.');
        // chosen the other way round: the same message (from the out port)
        expect(refused('diag.cycles', 'door.alarm')).toBe(refused('door.alarm', 'diag.cycles'));
        expect(refused('door.alarm', 'drive.up')).toBe(
            'door.alarm (out async) cannot be connected to drive.up (in async integer): the event door.alarm has no payload, but drive.up expects integer.');
        expect(refused('door.up', 'buzzer.alarm')).toBe(
            'door.up (out async integer) cannot be connected to buzzer.alarm (in async): the event door.up carries integer, but buzzer.alarm expects no payload.');
        expect(refused('sensor.position', 'diag.cycles')).toMatch(/^sensor\.position \(out sync door::Position\) cannot be connected to diag\.cycles \(in sync integer\): the data door::Position/);
        // the editor writes nothing
        expect(() => new StructureEditor(parsed.text, parsed.model).addConnection(s, end(s, 'door.alarm'), end(s, 'drive.up'))).toThrow(IncompatiblePortsError);
    });

    test('a sync in port has one source, an async in port one sender: a second one is refused', async () => {
        const text = deviceFile('garage-door.devm').replace('        sensor : PositionSensor\n', '        sensor : PositionSensor\n        backup : PositionSensor\n')
            .replace('        buzzer : Buzzer\n', '        buzzer : Buzzer\n        horn : Buzzer\n');
        const parsed = await load(text);
        const s = structure(parsed.model, 'GarageDoor');
        expect(() => planConnection(s, end(s, 'door.position'), end(s, 'backup.position'))).toThrow(
            'backup.position (out sync door::Position) cannot be connected to door.position (in sync door::Position): the sync port door.position already receives its data from sensor.position (a sync port has one source).');
        // an async in port has exactly one sender: a second connection or delegation is refused as well
        expect(() => planConnection(s, end(s, 'buzzer.alarm'), end(s, 'drive.stopped'))).toThrow(
            'drive.stopped (out async) cannot be connected to buzzer.alarm (in async): buzzer.alarm already receives its events from door.alarm (connect) – an async in port has exactly one sender.');
        expect(() => planConnection(s, end(s, 'drive.stopped'), end(s, 'door.open'))).toThrow(
            'drive.stopped (out async) cannot be connected to door.open (in async): door.open already receives its events from open (delegate) – an async in port has exactly one sender.');
        expect(() => planConnection(s, end(s, 'close'), end(s, 'door.open'))).toThrow(IncompatiblePortsError);
        // an out port may have several targets
        expect(planConnection(s, end(s, 'horn.alarm'), end(s, 'door.alarm')).text).toBe('connect door.alarm -> horn.alarm');
    });
});

describe('structure edits: ports, annotations, behavior', () => {
    test('add ports to a component and to the boundary of a structure', async () => {
        const { text, result } = await edit('components.devm', (e, m) => e.addPort(m.elements.find(x => x.name === 'Buzzer') as ast.Component,
            { direction: 'in', kind: 'sync', name: 'volume', type: 'integer' }));
        expect(text).toContain(`component Buzzer {
    in async alarm
    in sync volume : integer
}`);
        expect(text.substring(result.selectOffset!)).toMatch(/^in sync volume/);
        const boundary = await edit('drive-unit.devm', (e, m) => e.addPort(structure(m, 'DriveUnit'), { direction: 'in', kind: 'async' }));
        expect(boundary.result.createdName).toBe('in1');
        expect(boundary.text).toContain('    out async blocked\n    in async in1\n');
        const payload = await edit('drive-unit.devm', (e, m) => e.addPort(structure(m, 'DriveUnit'), { direction: 'out', kind: 'async', type: 'boolean' }));
        expect(payload.text).toContain('    out async blocked\n    out async out1 : boolean\n');
        const shared = await edit('drive-unit.devm', (e, m) => e.addPort(structure(m, 'DriveUnit'), { direction: 'inout', kind: 'sync' }));
        expect(shared.text).toContain('    out async blocked\n    inout sync inout1 : integer\n');
        const parsed = await load(deviceFile('drive-unit.devm'), 'drive-unit.devm');
        expect(() => new StructureEditor(parsed.text, parsed.model).addPort(structure(parsed.model, 'DriveUnit'), { direction: 'inout', kind: 'async' }))
            .toThrow(/An async port is an in or an out port/);
    });

    test('add a port to an empty component', async () => {
        const text = 'component C { }\n';
        const { text: result } = await edit('main.devm', (e, m) => e.addPort(m.elements[0] as ast.Component, { direction: 'out', kind: 'sync', name: 'x' }), text);
        expect(result).toBe('component C {\n    out sync x : integer\n}\n');
    });

    test('edit direction, kind and type of a port', async () => {
        const diagnosis = (m: ast.StructureModel) => m.elements.find(x => x.name === 'Diagnosis') as ast.Component;
        const port = (m: ast.StructureModel) => diagnosis(m).ports[0];
        const direction = await edit('components.devm', (e, m) => e.setPortDirection(port(m), 'out'));
        expect(direction.text).toContain('    out sync cycles : integer\n    inout sync errors');
        const kind = await edit('components.devm', (e, m) => e.setPortKind(port(m), 'async'));
        expect(kind.text).toContain('    in async cycles : integer\n');
        const type = await edit('components.devm', (e, m) => e.setPortType(port(m), '  door::Position '));
        expect(type.text).toContain('    in sync cycles : door::Position\n');
        // an inout port becoming async becomes an in port; a sync port needs a type
        const errors = await edit('components.devm', (e, m) => e.setPortKind(diagnosis(m).ports[1], 'async'));
        expect(errors.text).toContain('    in async errors : integer     // counted by the controller');
        const buzzer = (m: ast.StructureModel) => (m.elements.find(x => x.name === 'Buzzer') as ast.Component).ports[0];
        const sync = await edit('components.devm', (e, m) => e.setPortKind(buzzer(m), 'sync'));
        expect(sync.text).toContain('component Buzzer {\n    in sync alarm : integer\n}');
        // the payload of an async port: added, changed, removed
        const added = await edit('components.devm', (e, m) => e.setPortType(buzzer(m), 'integer'));
        expect(added.text).toContain('component Buzzer {\n    in async alarm : integer\n}');
        const removed = await edit('components.devm', (e, m) => e.setPortType(buzzer(m), ''), added.text);
        expect(removed.text).toContain('component Buzzer {\n    in async alarm\n}');
        const parsed = await load(deviceFile('components.devm'), 'components.devm');
        const editor = new StructureEditor(parsed.text, parsed.model);
        expect(() => editor.setPortType(port(parsed.model), ' ')).toThrow(/a sync port carries data/);
        expect(() => editor.setPortDirection(buzzer(parsed.model), 'inout')).toThrow(/An async port is an in or an out port/);
    });

    test('thread annotations: change, add, remove', async () => {
        const thread = (m: ast.StructureModel) => structure(m, 'GarageDoor').threads[0];
        const changed = await edit('garage-door.devm', (e, m) => e.setThreadAnnotations(thread(m), { priority: '7', stack: '1024' }));
        expect(changed.text).toContain('    @priority(7) @period(10 ms) @stack(1024)\n    thread ControlTask {');
        const removed = await edit('garage-door.devm', (e, m) => e.setThreadAnnotations(thread(m), { priority: '', period: undefined }));
        expect(removed.text).toContain('    out sync report : Diagnostics\n\n    thread ControlTask {');
        expect(removed.text).toContain('    @priority(2) @period(100 ms)\n    thread IoTask');
        const text = 'system S {\n    thread T {\n    }\n}\n';
        const added = await edit('main.devm', (e, m) => e.setThreadAnnotations(structure(m, 'S').threads[0], { period: '1 ms' }), text);
        expect(added.text).toBe('system S {\n    @period(1 ms)\n    thread T {\n    }\n}\n');
        const parsed = await load(text, 'main.devm');
        expect(() => new StructureEditor(text, parsed.model).setThreadAnnotations(structure(parsed.model, 'S').threads[0], { period: '10' })).toThrow(/not a period/);
    });

    test('set and remove the behavior of a component', async () => {
        const buzzer = (m: ast.StructureModel) => m.elements.find(x => x.name === 'Buzzer') as ast.Component;
        const set = await edit('components.devm', (e, m) => e.setBehavior(buzzer(m), 'buzzer.devm'));
        expect(set.text).toContain('component Buzzer {\n    behavior "buzzer.devm"\n    in async alarm');
        const replaced = await edit('components.devm', (e, m) => e.setBehavior(m.elements.find(x => x.name === 'DoorController') as ast.Component, 'drive.devm'));
        expect(replaced.text).toContain('component DoorController {\n    behavior "drive.devm"\n');
        const removed = await edit('components.devm', (e, m) => e.setBehavior(m.elements.find(x => x.name === 'DoorController') as ast.Component, ''));
        expect(removed.text).toContain('component DoorController {\n    in async open');
    });

    test('add component types', async () => {
        const { text, result } = await edit('components.devm', e => e.addComponentType('component'));
        expect(text.endsWith('    in sync report : Diagnostics\n}\n\ncomponent Component1 {\n}\n')).toBe(true);
        expect(text.substring(result.selectOffset!)).toMatch(/^component Component1/);
        const { text: empty } = await edit('main.devm', e => e.addComponentType('system', 'Car'), '// nothing yet\n');
        expect(empty).toBe('// nothing yet\n\nsystem Car {\n}\n');
    });
});

describe('structure edits: rename and delete', () => {
    test('rename an instance and its references in the file', async () => {
        const { text, errors } = await edit('garage-door.devm', (e, m) => e.rename(instance(structure(m, 'GarageDoor'), 'door'), 'gate'));
        expect(errors).toEqual([]);
        expect(text).toContain('        gate : DoorController\n');
        expect(text).toContain('    connect gate.up -> drive.up\n    connect gate.down -> drive.down\n');
        expect(text).toContain('    connect drive.stopped -> gate.stopped\n');
        expect(text).toContain('    delegate open -> gate.open\n');
        expect(text).not.toMatch(/\bdoor\./);
    });

    test('rename a component type and a port in all files (Langium references)', async () => {
        const workspace = new StructureWorkspace();
        const files: Record<string, string> = {};
        for (const file of DEVICE_FILES) {
            files[`file:///ws/${file}`] = deviceFile(file);
        }
        await workspace.update(files);
        const components = workspace.model('file:///ws/components.devm')!;
        const motor = components.elements.find(e => e.name === 'MotorController') as ast.Component;
        const edits = structureRenameEdits(workspace.services.Devm, motor, 'Motor');
        expect([...edits.keys()].sort()).toEqual(['file:///ws/components.devm', 'file:///ws/drive-unit.devm']);
        expect(applyEdits(files['file:///ws/drive-unit.devm'], edits.get('file:///ws/drive-unit.devm')!)).toContain('        motor : Motor\n');
        // a port of a component: the connections in the structures using it
        const duty = motor.ports.find(p => p.name === 'duty')!;
        const portEdits = workspace.renameEdits('file:///ws/components.devm', duty.$cstNode!.offset, 'pwm')!;
        expect(applyEdits(files['file:///ws/drive-unit.devm'], portEdits.get('file:///ws/drive-unit.devm')!)).toContain('    connect motor.pwm -> pwm.duty\n');
        expect(applyEdits(files['file:///ws/components.devm'], portEdits.get('file:///ws/components.devm')!)).toContain('    out sync pwm : integer ');
        // the interface of a port type is not a cross-reference: only its declaration and references are renamed
        expect(() => structureRenameEdits(workspace.services.Devm, motor, 'PwmDriver')).toThrow(/already exists/);
    });

    test('delete an instance with its connections and delegations', async () => {
        const { text, errors } = await edit('garage-door.devm', (e, m) => e.deleteElements([instance(structure(m, 'GarageDoor'), 'door')]));
        expect(text).not.toMatch(/door\.|door :/);
        expect(text).toContain('    thread ControlTask {\n        buzzer : Buzzer\n    }');
        expect(text).toContain('    delegate diag.report -> report\n}');
        expect(errors).toEqual([]);
    });

    test('delete a port with its connections', async () => {
        const { text } = await edit('drive-unit.devm', (e, m) => e.deleteElements([structure(m, 'DriveUnit').ports[0]]));
        expect(text).not.toMatch(/\bup\b/);
        expect(text).toContain('subsystem DriveUnit {\n    in async down : integer\n');
    });

    test('delete a port of a component type: its connections in the structures of other files', async () => {
        const workspace = new StructureWorkspace();
        const files: Record<string, string> = {};
        for (const file of DEVICE_FILES) {
            files[`file:///ws/${file}`] = deviceFile(file);
        }
        await workspace.update(files);
        const components = workspace.model('file:///ws/components.devm')!;
        const motor = components.elements.find(e => e.name === 'MotorController') as ast.Component;
        const ports = ['duty', 'up'].map(name => motor.ports.find(p => p.name === name)!.$cstNode!.offset);
        const edits = workspace.portDeletionEdits('file:///ws/components.devm', ports);
        expect([...edits.keys()]).toEqual(['file:///ws/drive-unit.devm']);
        const drive = applyEdits(files['file:///ws/drive-unit.devm'], edits.get('file:///ws/drive-unit.devm')!);
        expect(drive).not.toContain('motor.duty');
        expect(drive).not.toContain('delegate up -> motor.up');
        expect(drive).toContain('    connect switches.overcurrent -> motor.overcurrent\n    delegate down -> motor.down\n');
        expect(workspace.portDeletionEdits('file:///ws/components.devm', [])).toEqual(new Map());
    });

    test('delete a thread: with its instances and their connections', async () => {
        const { text, errors } = await edit('drive-unit.devm', (e, m) => e.deleteElements([structure(m, 'DriveUnit').threads[0]]));
        expect(text).not.toContain('MotorTask');
        expect(text).not.toMatch(/motor|pwm/);
        expect(text).toContain(`    // the end switches and the current monitor are interrupt driven
    @priority(10) @stack(1024)
    thread SwitchTask {
        switches : EndSwitches
    }

}`);
        // (the end switches are not connected any more)
        expect(errors).toEqual([]);
    });

    test('delete connections, a thread with a deleted instance, assignments by name', async () => {
        const { text } = await edit('garage-door.devm', (e, m) => {
            const s = structure(m, 'GarageDoor');
            return e.deleteElements([s.connections[0], s.delegations[1], s.threads[1], instance(s, 'diag')]);
        });
        expect(text).not.toContain('connect door.up -> drive.up');
        expect(text).not.toMatch(/diag|sensor|IoTask/);
        expect(text).toContain('        buzzer : Buzzer\n    }\n    // a subsystem');
        const named = 'import "components.devm"\nsystem S {\n    thread A {\n        b\n    }\n    b : Buzzer\n}\n';
        const { text: result } = await edit('main.devm', (e, m) => e.deleteElements([instance(structure(m, 'S'), 'b')]), named);
        expect(result).toBe('import "components.devm"\nsystem S {\n    thread A {\n    }\n}\n');
    });
});

describe('structure workspace: navigation across files', () => {
    async function workspace() {
        const ws = new StructureWorkspace();
        const files: Record<string, string> = {};
        for (const file of DEVICE_FILES) {
            files[`memory:///${file}`] = deviceFile(file);
        }
        await ws.update(files);
        return ws;
    }

    test('the instances using a state machine', async () => {
        const ws = await workspace();
        const usages = ws.behaviorUsages('memory:///drive.devm');
        expect(usages.map(u => u.component)).toEqual(['MotorController']);
        expect(usages[0].instances.map(i => i.location)).toEqual([{ uri: 'memory:/drive-unit.devm', element: 'DriveUnit', id: 'DriveUnit/motor' }]);
        expect(ws.behaviorUsages('memory:///controller.devm')[0].instances[0].location.id).toBe('GarageDoor/door');
    });

    test('contexts of a structure, routes into composites and sources across files', async () => {
        const ws = await workspace();
        const drive = ws.componentType('memory:///drive-unit.devm', 'DriveUnit') as ast.CompositeType;
        // the context given by a navigation from the system into its part drive
        const contexts = [{ rootUri: 'memory:/garage-door.devm', root: 'GarageDoor', path: ['drive'] }];
        expect(ws.resolveContext(contexts[0])?.structure).toBe(drive);
        expect(ws.resolveContext({ ...contexts[0], path: ['door'] })).toBeUndefined();
        // the route of door.up in the system continues into the drive
        const root = { rootUri: 'memory:///garage-door.devm', root: 'GarageDoor', path: [] };
        const start = ws.endpoint(root, 'door', 'up')!;
        const route = ws.route([start]);
        expect(routeContinuations(route, [])).toEqual(['drive']);
        expect([...routeIdsAt(route, ['drive'])].sort()).toEqual(['DriveUnit.up', 'DriveUnit/motor', 'DriveUnit/motor.up', 'DriveUnit/up->motor.up']);
        // the targets of an out port
        expect(ws.routeEnds(start, root).map(l => l.id)).toEqual(['DriveUnit/motor.up']);
        // from inside the drive: the source of the motor command is the door controller in the system file
        const up = ws.endpoint(contexts[0], 'motor', 'up')!;
        expect(ws.routeEnds(up, contexts[0])).toEqual([{ uri: 'memory:/garage-door.devm', element: 'GarageDoor', id: 'GarageDoor/door.up', context: { rootUri: 'memory:/garage-door.devm', root: 'GarageDoor', path: [] } }]);
        // the targets of the out port `stopped`: the door controller
        const stopped = ws.endpoint(contexts[0], 'motor', 'stopped')!;
        expect(ws.routeEnds(stopped, contexts[0]).map(l => l.id)).toEqual(['GarageDoor/door.stopped']);
    });

    test('a subsystem shown on its own: routes end at its boundary ports', async () => {
        const ws = await workspace();
        const standalone = { rootUri: 'memory:/drive-unit.devm', root: 'DriveUnit', path: [] };
        const stopped = ws.endpoint(standalone, 'motor', 'stopped')!;
        expect(ws.routeEnds(stopped, standalone).map(l => l.id)).toEqual(['DriveUnit.stopped']);
        const up = ws.endpoint(standalone, 'motor', 'up')!;
        expect(ws.routeEnds(up, standalone).map(l => l.id)).toEqual(['DriveUnit.up']);
    });
});
