import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import * as ast from '../src/generated/ast.js';
import { structureInstances } from '../src/dmf-model.js';
import { DmfWorkspace, routeContinuations, routeIdsAt } from '../src/dmf-workspace.js';
import { DmfEditor, dmfRenameEdits, planConnection, type DmfPortEnd } from '../src/edit/dmf-edits.js';
import { applyEdits, EditError, type EditResult } from '../src/edit/model-edits.js';
import { DmfModelLoader } from '../src/hsm-document.js';

const loader = new DmfModelLoader();
const DEVICE_DIR = path.resolve(__dirname, '../../../examples/device');
const deviceFile = (name: string) => fs.readFileSync(path.join(DEVICE_DIR, name), 'utf-8');
const DEVICE_FILES = ['types.dmf', 'components.dmf', 'drive.dmf', 'system.dmf', 'controller.hsm', 'drive.hsm', 'door_types.h'];

let counter = 0;

/** Loads a structure file of the device example (with the other files of the example). */
async function load(text: string, name = 'system.dmf') {
    const files: Record<string, string> = {};
    for (const file of DEVICE_FILES) {
        if (file !== name) {
            files[file] = deviceFile(file);
        }
    }
    return loader.load(text, `file:///work/edits-${counter++}/${name}`, { files });
}

/** Applies an edit to a file of the device example, checks that the result parses without errors and returns the new text. */
async function edit(name: string, op: (editor: DmfEditor, model: ast.DmfModel) => EditResult, text = deviceFile(name)) {
    const parsed = await load(text, name);
    expect(parsed.hasSyntaxErrors).toBe(false);
    const result = op(new DmfEditor(text, parsed.model), parsed.model);
    const changed = applyEdits(text, result.edits);
    const reparsed = await load(changed, name);
    expect(reparsed.hasSyntaxErrors, changed).toBe(false);
    return { text: changed, result, parsed: reparsed, errors: reparsed.diagnostics.filter(d => d.severity === 1).map(d => d.message) };
}

function structure(model: ast.DmfModel, name: string): ast.Structure {
    return model.elements.find((e): e is ast.Structure => ast.isStructure(e) && e.name === name)!;
}

function instance(s: ast.Structure, name: string): ast.ComponentInstance {
    return structureInstances(s).find(i => i.name === name)!;
}

function end(s: ast.Structure, text: string): DmfPortEnd {
    const [first, second] = text.split('.');
    if (second === undefined) {
        return { port: s.ports.find(p => p.name === first)! };
    }
    const part = instance(s, first);
    return { instance: part, port: part.type.ref!.ports.find(p => p.name === second)! };
}

describe('structure edits: threads and instances', () => {
    test('add a thread after the last thread', async () => {
        const { text, result } = await edit('system.dmf', (e, m) => e.addThread(structure(m, 'GarageDoor')));
        expect(result.createdName).toBe('Thread1');
        expect(text).toContain(`        diag : Diagnosis
    }
    thread Thread1 {
    }
    // a composite: its parts run in their own threads
    drive : DriveUnit`);
        expect(text.substring(result.selectOffset!)).toMatch(/^thread Thread1/);
    });

    test('add a thread with annotations', async () => {
        const { text } = await edit('drive.dmf', (e, m) => e.addThread(structure(m, 'DriveUnit'), 'SafetyTask', { priority: '9', period: '5 ms' }));
        expect(text).toContain(`        switches : EndSwitches
    }
    @priority(9) @period(5 ms)
    thread SafetyTask {
    }
`);
    });

    test('add an instance into a thread and outside of threads', async () => {
        const inThread = await edit('system.dmf', (e, m) => e.addInstance(structure(m, 'GarageDoor'), 'Buzzer', { thread: structure(m, 'GarageDoor').threads[1] }));
        expect(inThread.result.createdName).toBe('buzzer1');
        expect(inThread.text).toContain(`        diag : Diagnosis
        buzzer1 : Buzzer
    }`);
        expect(inThread.text.substring(inThread.result.selectOffset!)).toMatch(/^buzzer1 : Buzzer/);
        const passive = await edit('system.dmf', (e, m) => e.addInstance(structure(m, 'GarageDoor'), 'PwmDriver', { name: 'pwm' }));
        expect(passive.text).toContain(`    drive : DriveUnit
    pwm : PwmDriver

    connect door.motor -> drive.ctrl`);
    });

    test('add an instance into an empty thread', async () => {
        const text = 'import "components.dmf"\nsystem S {\n    thread T { }\n}\n';
        const { text: result } = await edit('main.dmf', (e, m) => e.addInstance(structure(m, 'S'), 'Buzzer', { thread: structure(m, 'S').threads[0] }), text);
        expect(result).toBe('import "components.dmf"\nsystem S {\n    thread T {\n        buzzer : Buzzer\n    }\n}\n');
    });

    test('names must be unique and valid', async () => {
        const parsed = await load(deviceFile('system.dmf'));
        const editor = new DmfEditor(parsed.text, parsed.model);
        expect(() => editor.addThread(structure(parsed.model, 'GarageDoor'), 'door')).toThrow(EditError);
        expect(() => editor.addThread(structure(parsed.model, 'GarageDoor'), 'thread')).toThrow(/not a valid name/);
        expect(() => editor.addInstance(structure(parsed.model, 'GarageDoor'), 'Buzzer', { name: 'IoTask' })).toThrow(/already has/);
    });

    test('move an instance between threads (with its comment)', async () => {
        const text = deviceFile('system.dmf').replace('        buzzer : Buzzer\n', '        // beeps\n        buzzer : Buzzer // the alarm\n');
        const { text: result, errors } = await edit('system.dmf', (e, m) => {
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

    test('move an instance out of its thread and into a thread', async () => {
        const out = await edit('system.dmf', (e, m) => {
            const s = structure(m, 'GarageDoor');
            return e.moveInstance(instance(s, 'sensor'), s);
        });
        expect(out.text).toContain(`    thread IoTask {
        diag : Diagnosis
    }`);
        expect(out.text).toContain(`    drive : DriveUnit
    sensor : PositionSensor
`);
        expect(out.text.substring(out.result.selectOffset!)).toMatch(/^sensor : PositionSensor/);
        const into = await edit('drive.dmf', (e, m) => {
            const s = structure(m, 'DriveUnit');
            return e.moveInstance(instance(s, 'pwm'), s.threads[0]);
        });
        // the comment line before the instance moves with it
        expect(into.text).toContain(`        switches : EndSwitches
        // passive: runs in the thread of its caller
        pwm : PwmDriver
    }

    connect motor.pwm -> pwm.duty`);
    });

    test('move an instance assigned by name', async () => {
        const text = 'import "components.dmf"\nsystem S {\n    thread A {\n        b\n    }\n    thread B { }\n    b : Buzzer\n}\n';
        const { text: result } = await edit('main.dmf', (e, m) => {
            const s = structure(m, 'S');
            return e.moveInstance(instance(s, 'b'), s.threads[1]);
        }, text);
        expect(result).toBe('import "components.dmf"\nsystem S {\n    thread A {\n    }\n    thread B {\n        b : Buzzer\n    }\n}\n');
    });

    test('change the type of an instance', async () => {
        const { text } = await edit('system.dmf', (e, m) => e.setInstanceType(instance(structure(m, 'GarageDoor'), 'buzzer'), 'Diagnosis'));
        expect(text).toContain('        buzzer : Diagnosis\n');
    });
});

describe('structure edits: connections', () => {
    test('connect a required to a provided port, swapped if drawn the other way', async () => {
        const text = deviceFile('system.dmf').replace('    connect door.alarm -> buzzer.alarm\n', '');
        const { text: result, result: r, errors } = await edit('system.dmf', (e, m) => {
            const s = structure(m, 'GarageDoor');
            return e.addConnection(s, end(s, 'buzzer.alarm'), end(s, 'door.alarm'));
        }, text);
        expect(errors).toEqual([]);
        expect((r as { plan: { swapped: boolean } }).plan.swapped).toBe(true);
        expect(result).toContain(`    connect diag.cycles -> door.cycles
    connect door.alarm -> buzzer.alarm
    delegate remote -> door.cmd`);
        expect(result.substring(r.selectOffset!)).toMatch(/^connect door.alarm -> buzzer.alarm/);
    });

    test('boundary port and port of a part: a delegation in the direction of the port', async () => {
        const text = deviceFile('drive.dmf').replace('    delegate ctrl -> motor.ctrl\n', '').replace('    delegate motor.status -> status\n', '');
        const { text: result } = await edit('drive.dmf', (e, m) => {
            const s = structure(m, 'DriveUnit');
            return e.addConnection(s, end(s, 'motor.ctrl'), end(s, 'ctrl'));
        }, text);
        expect(result).toContain('    connect switches.events -> motor.sensors\n    delegate ctrl -> motor.ctrl\n}');
        const { text: required } = await edit('drive.dmf', (e, m) => {
            const s = structure(m, 'DriveUnit');
            return e.addConnection(s, end(s, 'status'), end(s, 'motor.status'));
        }, result);
        expect(required).toContain('    delegate ctrl -> motor.ctrl\n    delegate motor.status -> status\n}');
    });

    test('invalid connections are refused, incompatible ones reported', async () => {
        const parsed = await load(deviceFile('system.dmf'));
        const s = structure(parsed.model, 'GarageDoor');
        expect(() => planConnection(s, end(s, 'door.cmd'), end(s, 'buzzer.alarm'))).toThrow(/Both ports are provided/);
        expect(() => planConnection(s, end(s, 'remote'), end(s, 'report'))).toThrow(/Two boundary ports/);
        expect(() => planConnection(s, end(s, 'remote'), end(s, 'door.motor'))).toThrow(/same direction/);
        expect(() => planConnection(s, end(s, 'door.motor'), end(s, 'drive.ctrl'))).toThrow(/already connected/);
        expect(() => planConnection(s, end(s, 'door.alarm'), end(s, 'door.cmd'))).toThrow(/same part/);
        const plan = planConnection(s, end(s, 'door.alarm'), end(s, 'sensor.position'));
        expect(plan.problems[0]).toMatch(/is async, 'position' is sync/);
        expect(planConnection(s, end(s, 'diag.cycles'), end(s, 'drive.ctrl')).problems.length).toBeGreaterThan(0);
    });
});

describe('structure edits: ports, annotations, behavior', () => {
    test('add ports to a component and to the boundary of a structure', async () => {
        const { text, result } = await edit('components.dmf', (e, m) => e.addPort(m.elements.find(x => x.name === 'Buzzer') as ast.Component,
            { direction: 'requires', kind: 'sync', name: 'volume', type: 'integer' }));
        expect(text).toContain(`component Buzzer {
    provides async alarm : event alarm
    requires sync volume : integer
}`);
        expect(text.substring(result.selectOffset!)).toMatch(/^requires sync volume/);
        const boundary = await edit('drive.dmf', (e, m) => e.addPort(structure(m, 'DriveUnit'), { direction: 'provides', kind: 'async' }));
        expect(boundary.result.createdName).toBe('in1');
        expect(boundary.text).toContain('    requires async status : MotorStatus\n    provides async in1 : event in1\n');
    });

    test('add a port to an empty component', async () => {
        const text = 'component C { }\n';
        const { text: result } = await edit('main.dmf', (e, m) => e.addPort(m.elements[0] as ast.Component, { direction: 'provides', kind: 'sync', name: 'x' }), text);
        expect(result).toBe('component C {\n    provides sync x : integer\n}\n');
    });

    test('edit direction, kind and type of a port', async () => {
        const port = (m: ast.DmfModel) => (m.elements.find(x => x.name === 'Diagnosis') as ast.Component).ports[0];
        const direction = await edit('components.dmf', (e, m) => e.setPortDirection(port(m), 'provides'));
        expect(direction.text).toContain('    provides sync cycles : integer\n    provides sync report');
        const kind = await edit('components.dmf', (e, m) => e.setPortKind(port(m), 'async'));
        expect(kind.text).toContain('    requires async cycles : integer\n');
        const type = await edit('components.dmf', (e, m) => e.setPortType(port(m), 'event tick ,  event tock : integer'));
        expect(type.text).toContain('    requires sync cycles : event tick , event tock : integer\n');
    });

    test('thread annotations: change, add, remove', async () => {
        const thread = (m: ast.DmfModel) => structure(m, 'GarageDoor').threads[0];
        const changed = await edit('system.dmf', (e, m) => e.setThreadAnnotations(thread(m), { priority: '7', stack: '1024' }));
        expect(changed.text).toContain('    @priority(7) @period(10 ms) @stack(1024)\n    thread ControlTask {');
        const removed = await edit('system.dmf', (e, m) => e.setThreadAnnotations(thread(m), { priority: '', period: undefined }));
        expect(removed.text).toContain('    provides sync report : Diagnostics\n\n    thread ControlTask {');
        expect(removed.text).toContain('    @priority(2) @period(100 ms)\n    thread IoTask');
        const text = 'system S {\n    thread T {\n    }\n}\n';
        const added = await edit('main.dmf', (e, m) => e.setThreadAnnotations(structure(m, 'S').threads[0], { period: '1 ms' }), text);
        expect(added.text).toBe('system S {\n    @period(1 ms)\n    thread T {\n    }\n}\n');
        const parsed = await load(text, 'main.dmf');
        expect(() => new DmfEditor(text, parsed.model).setThreadAnnotations(structure(parsed.model, 'S').threads[0], { period: '10' })).toThrow(/not a period/);
    });

    test('set and remove the behavior of a component', async () => {
        const buzzer = (m: ast.DmfModel) => m.elements.find(x => x.name === 'Buzzer') as ast.Component;
        const set = await edit('components.dmf', (e, m) => e.setBehavior(buzzer(m), 'buzzer.hsm'));
        expect(set.text).toContain('component Buzzer {\n    behavior "buzzer.hsm"\n    provides async alarm');
        const replaced = await edit('components.dmf', (e, m) => e.setBehavior(m.elements.find(x => x.name === 'DoorController') as ast.Component, 'drive.hsm'));
        expect(replaced.text).toContain('component DoorController {\n    behavior "drive.hsm"\n');
        const removed = await edit('components.dmf', (e, m) => e.setBehavior(m.elements.find(x => x.name === 'DoorController') as ast.Component, ''));
        expect(removed.text).toContain('component DoorController {\n    provides async cmd');
    });

    test('add component types', async () => {
        const { text, result } = await edit('components.dmf', e => e.addComponentType('component'));
        expect(text.endsWith('    provides sync report : Diagnostics\n}\n\ncomponent Component1 {\n}\n')).toBe(true);
        expect(text.substring(result.selectOffset!)).toMatch(/^component Component1/);
        const { text: empty } = await edit('main.dmf', e => e.addComponentType('system', 'Car'), '// nothing yet\n');
        expect(empty).toBe('// nothing yet\n\nsystem Car {\n}\n');
    });
});

describe('structure edits: rename and delete', () => {
    test('rename an instance and its references in the file', async () => {
        const { text, errors } = await edit('system.dmf', (e, m) => e.rename(instance(structure(m, 'GarageDoor'), 'door'), 'gate'));
        expect(errors).toEqual([]);
        expect(text).toContain('        gate : DoorController\n');
        expect(text).toContain('    connect gate.motor -> drive.ctrl\n    connect drive.status -> gate.status\n');
        expect(text).toContain('    delegate remote -> gate.cmd\n');
        expect(text).not.toMatch(/\bdoor\./);
    });

    test('rename a component type and a port in all files (Langium references)', async () => {
        const workspace = new DmfWorkspace();
        const files: Record<string, string> = {};
        for (const file of DEVICE_FILES) {
            files[`file:///ws/${file}`] = deviceFile(file);
        }
        await workspace.update(files);
        const components = workspace.model('file:///ws/components.dmf')!;
        const motor = components.elements.find(e => e.name === 'MotorController') as ast.Component;
        const edits = dmfRenameEdits(workspace.services.Dmf, motor, 'Motor');
        expect([...edits.keys()].sort()).toEqual(['file:///ws/components.dmf', 'file:///ws/drive.dmf']);
        expect(applyEdits(files['file:///ws/drive.dmf'], edits.get('file:///ws/drive.dmf')!)).toContain('        motor : Motor\n');
        // a port of a component: the connections in the structures using it
        const ctrl = motor.ports.find(p => p.name === 'pwm')!;
        const portEdits = workspace.renameEdits('file:///ws/components.dmf', ctrl.$cstNode!.offset, 'duty')!;
        expect(applyEdits(files['file:///ws/drive.dmf'], portEdits.get('file:///ws/drive.dmf')!)).toContain('    connect motor.duty -> pwm.duty\n');
        expect(applyEdits(files['file:///ws/components.dmf'], portEdits.get('file:///ws/components.dmf')!)).toContain('    requires sync duty : integer\n');
        // the interface of a port type is not a cross-reference: only its declaration and references are renamed
        expect(() => dmfRenameEdits(workspace.services.Dmf, motor, 'PwmDriver')).toThrow(/already exists/);
    });

    test('delete an instance with its connections and delegations', async () => {
        const { text, errors } = await edit('system.dmf', (e, m) => e.deleteElements([instance(structure(m, 'GarageDoor'), 'door')]));
        expect(text).not.toMatch(/door\.|door :/);
        expect(text).toContain('    thread ControlTask {\n        buzzer : Buzzer\n    }');
        expect(text).toContain('    delegate report -> diag.report\n}');
        expect(errors).toEqual([]);
    });

    test('delete a port with its connections', async () => {
        const { text } = await edit('drive.dmf', (e, m) => e.deleteElements([structure(m, 'DriveUnit').ports[0]]));
        expect(text).not.toContain('ctrl');
        expect(text).toContain('structure DriveUnit {\n    requires async status : MotorStatus\n');
    });

    test('delete a port of a component type: its connections in the structures of other files', async () => {
        const workspace = new DmfWorkspace();
        const files: Record<string, string> = {};
        for (const file of DEVICE_FILES) {
            files[`file:///ws/${file}`] = deviceFile(file);
        }
        await workspace.update(files);
        const components = workspace.model('file:///ws/components.dmf')!;
        const motor = components.elements.find(e => e.name === 'MotorController') as ast.Component;
        const ports = ['pwm', 'ctrl'].map(name => motor.ports.find(p => p.name === name)!.$cstNode!.offset);
        const edits = workspace.portDeletionEdits('file:///ws/components.dmf', ports);
        expect([...edits.keys()]).toEqual(['file:///ws/drive.dmf']);
        const drive = applyEdits(files['file:///ws/drive.dmf'], edits.get('file:///ws/drive.dmf')!);
        expect(drive).not.toContain('motor.pwm');
        expect(drive).not.toContain('delegate ctrl -> motor.ctrl');
        expect(drive).toContain('    connect switches.events -> motor.sensors\n    delegate motor.status -> status\n}');
        expect(workspace.portDeletionEdits('file:///ws/components.dmf', [])).toEqual(new Map());
    });

    test('delete a thread: its instances stay in the structure', async () => {
        const { text, errors } = await edit('drive.dmf', (e, m) => e.deleteElements([structure(m, 'DriveUnit').threads[0]]));
        expect(errors).toEqual([]);
        expect(text).toContain(`    requires async status : MotorStatus

    motor : MotorController
    switches : EndSwitches
    // passive: runs in the thread of its caller
    pwm : PwmDriver`);
        expect(text).not.toContain('@priority');
    });

    test('delete connections, a thread with a deleted instance, assignments by name', async () => {
        const { text } = await edit('system.dmf', (e, m) => {
            const s = structure(m, 'GarageDoor');
            return e.deleteElements([s.connections[0], s.delegations[1], s.threads[1], instance(s, 'diag')]);
        });
        expect(text).not.toContain('connect door.motor -> drive.ctrl');
        expect(text).not.toContain('diag');
        expect(text).toContain('    }\n    sensor : PositionSensor\n    // a composite');
        const named = 'import "components.dmf"\nsystem S {\n    thread A {\n        b\n    }\n    b : Buzzer\n}\n';
        const { text: result } = await edit('main.dmf', (e, m) => e.deleteElements([instance(structure(m, 'S'), 'b')]), named);
        expect(result).toBe('import "components.dmf"\nsystem S {\n    thread A {\n    }\n}\n');
    });
});

describe('structure workspace: navigation across files', () => {
    async function workspace() {
        const ws = new DmfWorkspace();
        const files: Record<string, string> = {};
        for (const file of DEVICE_FILES) {
            files[`memory:///${file}`] = deviceFile(file);
        }
        await ws.update(files);
        return ws;
    }

    test('the instances using a state machine', async () => {
        const ws = await workspace();
        const usages = ws.behaviorUsages('memory:///drive.hsm');
        expect(usages.map(u => u.component)).toEqual(['MotorController']);
        expect(usages[0].instances.map(i => i.location)).toEqual([{ uri: 'memory:/drive.dmf', element: 'DriveUnit', id: 'DriveUnit/motor' }]);
        expect(ws.behaviorUsages('memory:///controller.hsm')[0].instances[0].location.id).toBe('GarageDoor/door');
    });

    test('contexts of a structure, routes into composites and providers across files', async () => {
        const ws = await workspace();
        const drive = ws.componentType('memory:///drive.dmf', 'DriveUnit') as ast.Structure;
        const contexts = ws.contextsOf(drive);
        expect(contexts).toEqual([{ rootUri: 'memory:/system.dmf', root: 'GarageDoor', path: ['drive'] }]);
        // the route of door.motor in the system continues into the drive
        const root = { rootUri: 'memory:///system.dmf', root: 'GarageDoor', path: [] };
        const start = ws.endpoint(root, 'door', 'motor')!;
        const route = ws.route([start]);
        expect(routeContinuations(route, [])).toEqual(['drive']);
        expect([...routeIdsAt(route, ['drive'])].sort()).toEqual(['DriveUnit.ctrl', 'DriveUnit/ctrl->motor.ctrl', 'DriveUnit/motor', 'DriveUnit/motor.ctrl']);
        expect(ws.routeEnds(start, root).map(l => l.id)).toEqual(['DriveUnit/motor.ctrl']);
        // from inside the drive: the provider of the status is the door controller in the system file
        const status = ws.endpoint(contexts[0], 'motor', 'status')!;
        const providers = ws.routeEnds(status, contexts[0]);
        expect(providers).toEqual([{ uri: 'memory:/system.dmf', element: 'GarageDoor', id: 'GarageDoor/door.status', context: { rootUri: 'memory:/system.dmf', root: 'GarageDoor', path: [] } }]);
    });
});
